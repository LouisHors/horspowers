#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "open3"
require "psych"
require "time"
require "tmpdir"
require "date"
require_relative "host_trace_parser"

ROOT = File.expand_path("../..", __dir__)
CORPUS_PATH = File.join(__dir__, "corpus.yaml")
RUNS_DIR = File.join(__dir__, "runs")
RUN_ID = ENV.fetch("SKILL_TRIGGER_RUN_ID", Time.now.utc.strftime("%Y-%m-%d-fast-slow-routing-v1"))
ARTIFACT_ROOT = File.join(RUNS_DIR, "artifacts", "#{RUN_ID.gsub(/[^a-z0-9-]+/i, "-")}-#{Process.pid}")
RESULTS_PATH = File.join(ARTIFACT_ROOT, "results.jsonl")
SUMMARY_PATH = File.join(ARTIFACT_ROOT, "summary.json")
ROUTE_SCRIPT = File.realpath(File.join(ROOT, "skills", "using-horspowers", "scripts", "route-request.mjs"))
USING_HORSPOWERS_SKILL = File.realpath(File.join(ROOT, "skills", "using-horspowers", "SKILL.md"))
ROUTE_RULES_PATH = File.realpath(File.join(ROOT, "skills", "using-horspowers", "references", "route-rules.json"))

CLAUDE_BIN = ENV.fetch("CLAUDE_BIN", "claude")
CODEX_BIN = ENV.fetch("CODEX_BIN", "codex")
TIMEOUT_SECONDS = Integer(ENV.fetch("SKILL_TRIGGER_TIMEOUT", "240"))
MAX_WORKERS = Integer(ENV.fetch("SKILL_TRIGGER_MAX_WORKERS", "4"))
CLAUDE_BARE = ENV.fetch("SKILL_TRIGGER_CLAUDE_BARE", "false") == "true"
CLAUDE_PLUGIN_DIR = ENV.fetch("SKILL_TRIGGER_CLAUDE_PLUGIN_DIR", "")
ROUTE_ONLY = ENV.fetch("SKILL_TRIGGER_ROUTE_ONLY", "false") == "true"
ONLY_HOST = ENV.fetch("SKILL_TRIGGER_ONLY_HOST", "").strip

HOSTS = %w[claude codex].freeze

def slug(text)
  text.gsub(/[^a-z0-9]+/i, "-").gsub(/\A-+|-+\z/, "").downcase
end

def selected_hosts
  return HOSTS if ONLY_HOST.empty?
  raise "SKILL_TRIGGER_ONLY_HOST must be codex or claude" unless HOSTS.include?(ONLY_HOST)

  [ONLY_HOST]
end

def ensure_directory(path)
  return if Dir.exist?(path)

  parent = File.dirname(path)
  ensure_directory(parent) unless Dir.exist?(parent)
  Dir.mkdir(path)
rescue Errno::EEXIST
  raise unless Dir.exist?(path)
end

def create_directory_once(path)
  raise "artifact directory already exists: #{path}" if File.exist?(path) || File.symlink?(path)

  Dir.mkdir(path)
end

def exclusive_write(path, content)
  File.open(path, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(content) }
end

def run_with_capture(command, cwd:, timeout_seconds:)
  stdout = +""
  stderr = +""
  status = nil
  timed_out = false

  Open3.popen3(*command, chdir: cwd) do |stdin, out, err, wait_thr|
    stdin.close

    out_thread = Thread.new { out.read }
    err_thread = Thread.new { err.read }

    if wait_thr.join(timeout_seconds)
      status = wait_thr.value
    else
      timed_out = true
      Process.kill("TERM", wait_thr.pid) rescue nil
      if !wait_thr.join(5)
        Process.kill("KILL", wait_thr.pid) rescue nil
        wait_thr.join
      end
      status = wait_thr.value
    end

    stdout = out_thread.value
    stderr = err_thread.value
  end

  {
    stdout: stdout,
    stderr: stderr,
    exit_code: status&.exitstatus,
    success: status&.success? && !timed_out,
    timed_out: timed_out
  }
end

def stability_flags(text)
  flags = []
  flags << "stream_disconnected" if text.include?("stream disconnected")
  flags << "reconnecting" if text.include?("Reconnecting")
  flags << "startup_remote_sync_failed" if text.include?("startup remote plugin sync failed")
  flags << "featured_plugin_sync_failed" if text.include?("failed to warm featured plugin ids cache")
  flags
end

def startup_profiles_by_host
  @startup_profiles_by_host ||= begin
    run_metadata = Psych.load_file(File.join(RUNS_DIR, "baseline-template.yaml"), permitted_classes: [Date])
    hosts = run_metadata.fetch("hosts")
    hosts.each_with_object({}) do |(host, meta), acc|
      profile_path = meta["startup_profile"]
      acc[host] =
        if profile_path && !profile_path.empty?
          File.read(File.join(ROOT, profile_path))
        else
          nil
        end
    end
  rescue Psych::Exception
    {}
  end
end

def current_startup_profile(host)
  host_profile = startup_profiles_by_host.fetch(host, "")
  using_horspowers = File.read(USING_HORSPOWERS_SKILL)
  <<~PROFILE
    #{host_profile}

    ## Current worktree routing profile

    The following is the canonical, slim `using-horspowers` profile from this worktree.
    #{using_horspowers}
  PROFILE
end

def create_route_fixture(sample_dir, host, sample)
  fake_home = Dir.mktmpdir("skill-trigger-#{host}-home-")
  fixture_root = Dir.mktmpdir("skill-trigger-#{host}-git-fixture-")
  git_init = run_with_capture(["git", "init"], cwd: fixture_root, timeout_seconds: 15)
  raise "could not initialize Git fixture: #{git_init[:stderr]}" unless git_init[:success]

  input_path = File.join(sample_dir, "#{host}.route-input.json")
  exclusive_write(input_path, JSON.generate(
    "schema_version" => 1,
    "host" => host,
    "cwd" => fixture_root,
    "message" => sample.fetch("user_message"),
    "active_route" => nil
  ))

  {
    "fake_home" => fake_home,
    "fixture_root" => fixture_root,
    "route_input_path" => input_path
  }
end

def route_only_instruction(fixture)
  <<~INSTRUCTION
    Evaluation route-only mode. Do not execute the user's request. Do not inspect the repository,
    invoke qmd, or call any workflow tool other than the single router invocation below.

    Run exactly one command, with no substitutions and no extra arguments:
    HOME='#{fixture.fetch("fake_home")}' node '#{ROUTE_SCRIPT}' < '#{fixture.fetch("route_input_path")}'

    Read its one-line JSON result. If `routing.target_skill` is non-null, announce and load only
    that unique target skill, then stop. If the route is `direct` or `uncertain`, stop after
    stating that route. Do not perform the original user task.
  INSTRUCTION
end

def build_command(host:, prompt:, startup_text:, fixture:)
  effective_startup = startup_text.to_s.dup
  effective_startup << "\n\n#{route_only_instruction(fixture)}" if ROUTE_ONLY

  case host
  when "claude"
    command = [CLAUDE_BIN, "-p", prompt]
    command += ["--append-system-prompt", effective_startup] unless effective_startup.empty?
    command << "--bare" if CLAUDE_BARE
    command += ["--plugin-dir", CLAUDE_PLUGIN_DIR] unless CLAUDE_PLUGIN_DIR.empty?
    command += ["--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]
  when "codex"
    effective_prompt = "#{effective_startup}\n\nUser request:\n#{prompt}"
    command = [CODEX_BIN, "exec", "--json", effective_prompt]
  else
    raise "unsupported host: #{host}"
  end
  command
end

def expected_target_skill(sample)
  expected = sample.fetch("expected_skill")
  expected.empty? ? nil : "horspowers:#{expected}"
end

def score_result(sample, trace)
  routing = trace.router_json || {}
  actual_target = routing["target_skill"]
  actual_route = routing["route"]
  integration_failures = []
  integration_failures << "router_calls=#{trace.router_calls}" unless trace.router_calls == 1
  integration_failures << "router JSON missing" if trace.router_json.nil?
  integration_failures.concat(trace.runtime_failures) unless trace.runtime_failures.empty?

  if sample.fetch("should_trigger")
    expected = expected_target_skill(sample)
    outcome =
      if actual_target == expected
        "exact"
      elsif sample.fetch("secondary_ok_skills").include?(actual_target.to_s.sub("horspowers:", ""))
        "acceptable"
      elsif actual_target.nil?
        "miss"
      else
        "wrong"
      end
  else
    over_trigger = !trace.target_skill_mentions.empty? || trace.qmd_calls.positive?
    outcome = "no-trigger-expected"
    direct_without_tools = sample.fetch("expected_route") == "direct" && actual_route == "direct" &&
      trace.router_calls == 1 && trace.qmd_calls.zero? && trace.other_tool_calls.zero?
    integration_failures << "direct route invoked extra tools" if actual_route == "direct" && !direct_without_tools
  end

  {
    "outcome" => outcome,
    "actual_route" => actual_route,
    "actual_target_skill" => actual_target,
    "over_trigger" => defined?(over_trigger) ? over_trigger : false,
    "direct_without_tools" => defined?(direct_without_tools) ? direct_without_tools : false,
    "integration_failures" => integration_failures
  }
end

def main
  ensure_directory(File.dirname(ARTIFACT_ROOT))
  create_directory_once(ARTIFACT_ROOT)

  corpus = Psych.load_file(CORPUS_PATH, permitted_classes: [Date])
  route_rules = JSON.parse(File.read(ROUTE_RULES_PATH))
  hosts = selected_hosts
  summary = {
    "started_at" => Time.now.iso8601,
    "cwd" => ROOT,
    "timeout_seconds" => TIMEOUT_SECONDS,
    "max_workers" => MAX_WORKERS,
    "claude_bin" => CLAUDE_BIN,
    "codex_bin" => CODEX_BIN,
    "sample_count" => corpus.size,
    "run_metadata" => {
      "route_only" => ROUTE_ONLY,
      "route_script" => ROUTE_SCRIPT,
      "routing_rule_version" => route_rules.fetch("routing_rule_version"),
      "artifact_root" => ARTIFACT_ROOT
    },
    "host_runs" => {}
  }

  hosts.each do |host|
    summary["host_runs"][host] = {
      "completed" => 0,
      "exit_0" => 0,
      "timed_out" => 0,
      "stream_disconnected" => 0,
      "reconnecting" => 0,
      "positive_total" => 0,
      "negative_total" => 0,
      "exact" => 0,
      "acceptable" => 0,
      "miss" => 0,
      "wrong" => 0,
      "no_trigger_expected" => 0,
      "over_trigger_count" => 0,
      "over_trigger_rate" => 0,
      "direct_without_tools" => 0
    }
  end

  jobs = []
  corpus.each_with_index do |sample, index|
    sample_dir = File.join(ARTIFACT_ROOT, format("%02d-%s", index + 1, slug(sample.fetch("id"))))
    create_directory_once(sample_dir)
    hosts.each do |host|
      fixture = create_route_fixture(sample_dir, host, sample)
      startup_text = current_startup_profile(host)
      sample_dir = File.join(ARTIFACT_ROOT, format("%02d-%s", index + 1, slug(sample.fetch("id"))))
      jobs << {
        "sample" => sample,
        "host" => host,
        "command" => build_command(host: host, prompt: sample.fetch("user_message"), startup_text: startup_text, fixture: fixture),
        "sample_dir" => sample_dir,
        "startup_profile_loaded" => !startup_text.to_s.empty?,
        "fixture" => fixture
      }
    end
  end

  results_mutex = Mutex.new
  jobs_mutex = Mutex.new
  results_file = File.open(RESULTS_PATH, File::WRONLY | File::CREAT | File::EXCL, 0o600)

  workers = Array.new(MAX_WORKERS) do
    Thread.new do
      loop do
        job = nil
        jobs_mutex.synchronize { job = jobs.shift }
        break unless job

        sample = job.fetch("sample")
        host = job.fetch("host")
        command = job.fetch("command")
        sample_dir = job.fetch("sample_dir")
        startup_profile_loaded = job.fetch("startup_profile_loaded")
        fixture = job.fetch("fixture")

        run = run_with_capture(command, cwd: ROOT, timeout_seconds: TIMEOUT_SECONDS)

        stdout_path = File.join(sample_dir, "#{host}.stdout.txt")
        stderr_path = File.join(sample_dir, "#{host}.stderr.txt")
        meta_path = File.join(sample_dir, "#{host}.meta.json")

        exclusive_write(stdout_path, run[:stdout])
        exclusive_write(stderr_path, run[:stderr])

        flags = stability_flags("#{run[:stdout]}\n#{run[:stderr]}")
        trace = HostTraceParser.parse(host: host, stdout: run[:stdout], stderr: run[:stderr])
        score = score_result(sample, trace)
        meta = {
          "sample_id" => sample.fetch("id"),
          "host" => host,
          "expected_skill" => sample.fetch("expected_skill"),
          "expected_route" => sample.fetch("expected_route"),
          "secondary_ok_skills" => sample.fetch("secondary_ok_skills"),
          "should_trigger" => sample.fetch("should_trigger"),
          "startup_profile_loaded" => startup_profile_loaded,
          "command" => command,
          "exit_code" => run[:exit_code],
          "success" => run[:success],
          "timed_out" => run[:timed_out],
          "stability_flags" => flags,
          "trace" => {
            "router_calls" => trace.router_calls,
            "router_json" => trace.router_json,
            "target_skill_mentions" => trace.target_skill_mentions,
            "qmd_calls" => trace.qmd_calls,
            "other_tool_calls" => trace.other_tool_calls,
            "runtime_failures" => trace.runtime_failures
          },
          "score" => score,
          "fixture" => fixture,
          "stdout_path" => stdout_path,
          "stderr_path" => stderr_path,
          "ran_at" => Time.now.iso8601
        }
        exclusive_write(meta_path, JSON.pretty_generate(meta))

        results_mutex.synchronize do
          results_file.puts(JSON.generate(meta))
          results_file.flush

          host_summary = summary["host_runs"][host]
          host_summary["completed"] += 1
          host_summary["exit_0"] += 1 if run[:exit_code] == 0
          host_summary["timed_out"] += 1 if run[:timed_out]
          host_summary["stream_disconnected"] += 1 if flags.include?("stream_disconnected")
          host_summary["reconnecting"] += 1 if flags.include?("reconnecting")
          if sample.fetch("should_trigger")
            host_summary["positive_total"] += 1
          else
            host_summary["negative_total"] += 1
          end
          host_summary[score.fetch("outcome").tr("-", "_")] += 1
          host_summary["over_trigger_count"] += 1 if score.fetch("over_trigger")
          host_summary["direct_without_tools"] += 1 if score.fetch("direct_without_tools")
        end

        puts "[#{host}] #{sample.fetch("id")} exit=#{run[:exit_code]} timeout=#{run[:timed_out]} flags=#{flags.join(",")}"
      end
    end
  end

  workers.each(&:join)
  results_file.close
  summary["host_runs"].each_value do |host_summary|
    negatives = host_summary.fetch("negative_total")
    host_summary["over_trigger_rate"] = negatives.zero? ? 0 : host_summary.fetch("over_trigger_count").fdiv(negatives)
  end
  summary["finished_at"] = Time.now.iso8601
  exclusive_write(SUMMARY_PATH, JSON.pretty_generate(summary))

  puts
  puts "Artifacts: #{ARTIFACT_ROOT}"
  puts "Summary:   #{SUMMARY_PATH}"
end

main if __FILE__ == $PROGRAM_NAME
