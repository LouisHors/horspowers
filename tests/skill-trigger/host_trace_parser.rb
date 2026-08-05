#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"

TraceResult = Struct.new(
  :router_calls, :router_json, :target_skill_mentions,
  :qmd_calls, :other_tool_calls, :runtime_failures,
  keyword_init: true
)

module HostTraceParser
  ROUTER_SCRIPT = /route-request\.mjs/i
  QMD_COMMAND = /\bqmd\b/i
  TARGET_SKILL = /horspowers:[a-z][a-z-]*/i
  TOOL_TYPES = %w[tool_use function_call command_execution tool_call].freeze

  module_function

  def parse(host:, stdout:, stderr: "")
    raise ArgumentError, "unsupported host: #{host}" unless %w[codex claude].include?(host)

    router_calls = 0
    router_json = nil
    target_skill_mentions = []
    qmd_calls = 0
    other_tool_calls = 0
    runtime_failures = []

    stdout.to_s.each_line.with_index(1) do |line, line_number|
      next if line.strip.empty?

      begin
        event = JSON.parse(line)
      rescue JSON::ParserError
        runtime_failures << "malformed trace line #{line_number}"
        next
      end

      strings = collect_strings(event)
      strings.flat_map { |value| value.scan(TARGET_SKILL) }.each do |skill|
        target_skill_mentions << skill unless target_skill_mentions.include?(skill)
      end

      tool_events(event).each do |tool_event|
        text = JSON.generate(tool_event)
        if text.match?(ROUTER_SCRIPT)
          router_calls += 1
        elsif text.match?(QMD_COMMAND)
          qmd_calls += 1
        else
          other_tool_calls += 1
        end
      end

      extract_router_payloads(event).each do |payload|
        if router_json && router_json != payload
          runtime_failures << "multiple router JSON results"
        end
        router_json ||= payload
      end

      runtime_failure_for(event, strings)&.then { |failure| runtime_failures << failure }
    end

    stderr.to_s.each_line do |line|
      failure = line.strip
      runtime_failures << failure unless failure.empty?
    end

    TraceResult.new(
      router_calls: router_calls,
      router_json: router_json,
      target_skill_mentions: target_skill_mentions,
      qmd_calls: qmd_calls,
      other_tool_calls: other_tool_calls,
      runtime_failures: runtime_failures.uniq
    )
  end

  def collect_strings(value, values = [])
    case value
    when Hash
      value.each_value { |child| collect_strings(child, values) }
    when Array
      value.each { |child| collect_strings(child, values) }
    when String
      values << value
    end
    values
  end

  def tool_events(value, events = [])
    case value
    when Hash
      events << value if TOOL_TYPES.include?(value["type"])
      value.each_value { |child| tool_events(child, events) }
    when Array
      value.each { |child| tool_events(child, events) }
    end
    events
  end

  def extract_router_payloads(value, payloads = [])
    case value
    when Hash
      routing = value["routing"]
      if routing.is_a?(Hash) && routing.key?("route") && routing.key?("target_skill")
        payloads << routing.slice("route", "target_skill")
      elsif value.key?("route") && value.key?("target_skill")
        payloads << value.slice("route", "target_skill")
      end
      value.each_value { |child| extract_router_payloads(child, payloads) }
    when Array
      value.each { |child| extract_router_payloads(child, payloads) }
    when String
      stripped = value.strip
      if (stripped.start_with?("{") || stripped.start_with?("["))
        begin
          extract_router_payloads(JSON.parse(stripped), payloads)
        rescue JSON::ParserError
          # A non-JSON textual tool result is not an invalid host trace line.
        end
      end
    end
    payloads.uniq
  end

  def runtime_failure_for(event, strings)
    types = []
    collect_types(event, types)
    return nil unless types.any? { |type| %w[error failed failure].include?(type.to_s.downcase) }

    strings.find { |value| value.match?(/stream disconnected|runtime failure|timed out|failed/i) } || "runtime failure"
  end

  def collect_types(value, types)
    case value
    when Hash
      types << value["type"] if value.key?("type")
      types << value["status"] if value.key?("status")
      value.each_value { |child| collect_types(child, types) }
    when Array
      value.each { |child| collect_types(child, types) }
    end
    types
  end
end
