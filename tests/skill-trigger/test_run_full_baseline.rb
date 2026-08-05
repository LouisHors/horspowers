#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require_relative "run_full_baseline"

class RunFullBaselineTest < Minitest::Test
  def fixture
    {
      "fake_home" => "/fixture/home",
      "fixture_root" => "/fixture/project",
      "route_input_path" => "/fixture/route-input.json"
    }
  end

  def test_route_only_instruction_requires_router_for_direct_requests
    instruction = route_only_instruction(fixture)

    assert_includes instruction, "mandatory for every user request"
    assert_includes instruction, "including a direct, trivial, translation, or no-skill request"
    assert_match(/evaluation harness\s+infrastructure, not a workflow skill/, instruction)
  end

  def test_builds_claude_route_only_command_with_bash_only_terminal_protocol
    command = build_command(
      host: "claude",
      prompt: "请翻译这句话",
      startup_text: "baseline profile",
      fixture: fixture,
      route_only: true
    )
    system_prompt = command.fetch(command.index("--system-prompt") + 1)

    assert_equal ["--tools", "Bash"], command.each_cons(2).find { |pair| pair == ["--tools", "Bash"] }
    assert_includes system_prompt, "final response MUST be exactly `Route: <route>`"
    assert_includes system_prompt, "final response MUST be exactly `Target skill: <target_skill>`"
    assert_match(/Do not invoke a Skill or any\s+other tool after the router command/, system_prompt)
  end

  def test_builds_codex_route_only_prompt_with_terminal_protocol_after_user_request
    command = build_command(
      host: "codex",
      prompt: "请简短解释 router 这个术语。",
      startup_text: "baseline profile",
      fixture: fixture,
      route_only: true
    )
    effective_prompt = command.last

    assert_operator effective_prompt.index("Route the opaque user request"), :<, effective_prompt.index("ROUTE-ONLY EVALUATION")
    assert_includes effective_prompt, "final response MUST be exactly `Route: <route>`"
    assert_equal ["-C", "/fixture/project"], command.each_cons(2).find { |pair| pair == ["-C", "/fixture/project"] }
  end

  def test_builds_fixture_scoped_route_only_agents_instructions
    instructions = route_only_agents_instructions(fixture)

    assert_includes instructions, "ROUTE-ONLY EVALUATION"
    assert_includes instructions, "mandatory for every user request"
    assert_includes instructions, "final response MUST be exactly `Route: <route>`"
  end

  def test_route_only_instruction_uses_short_fixture_local_invocation_paths
    route_fixture = fixture.merge(
      "route_home" => ".route-home",
      "route_input_command_path" => "route-input.json",
      "route_script_command_path" => "route-request.mjs"
    )

    instruction = route_only_instruction(route_fixture)

    assert_includes instruction, "HOME='.route-home' node 'route-request.mjs' < 'route-input.json'"
    refute_includes instruction, ROUTE_SCRIPT
  end

  def test_creates_a_fixture_local_router_entry_without_replacing_artifact_input
    root = Dir.mktmpdir("skill-trigger-route-only-fixture-")
    sample_dir = File.join(root, "artifact")
    Dir.mkdir(sample_dir)

    route_fixture = create_route_fixture(sample_dir, "codex", {
      "user_message" => "请先系统排查根因"
    })

    assert_equal ".route-home", route_fixture.fetch("route_home")
    assert_equal "route-input.json", route_fixture.fetch("route_input_command_path")
    assert_equal "route-request.mjs", route_fixture.fetch("route_script_command_path")
    assert_equal ROUTE_SCRIPT, File.realpath(File.join(route_fixture.fetch("fixture_root"), "route-request.mjs"))
    assert_equal(
      File.read(File.join(sample_dir, "codex.route-input.json")),
      File.read(File.join(route_fixture.fetch("fixture_root"), "route-input.json"))
    )
  end

  def test_route_only_fixture_agents_instructions_use_the_same_short_local_entry
    root = Dir.mktmpdir("skill-trigger-route-only-agents-")
    sample_dir = File.join(root, "artifact")
    Dir.mkdir(sample_dir)

    route_fixture = create_route_fixture(sample_dir, "codex", {
      "user_message" => "请先系统排查根因"
    }, route_only: true)
    instructions = File.read(File.join(route_fixture.fetch("fixture_root"), "AGENTS.md"))

    assert_includes instructions, "HOME='.route-home' node 'route-request.mjs' < 'route-input.json'"
    refute_includes instructions, ROUTE_SCRIPT
  end

  def test_uses_an_opaque_route_only_host_prompt_for_both_hosts
    ["claude", "codex"].each do |host|
      command = build_command(
        host: host,
        prompt: "请简短解释 router 这个术语。",
        startup_text: "baseline profile",
        fixture: fixture,
        route_only: true
      )
      host_prompt = host == "claude" ? command.fetch(command.index("-p") + 1) : command.last

      assert_includes host_prompt, "opaque user request"
      refute_includes host_prompt, "请简短解释 router 这个术语。"
    end
  end
end
