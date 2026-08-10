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
    seen_tool_event_ids = {}

    stdout.to_s.each_line.with_index(1) do |line, line_number|
      next if line.strip.empty?

      begin
        event = JSON.parse(line)
      rescue JSON::ParserError
        runtime_failures << "malformed trace line #{line_number}"
        next
      end

      strings = trace_strings(host, event)
      strings.flat_map { |value| value.scan(TARGET_SKILL) }.each do |skill|
        target_skill_mentions << skill unless target_skill_mentions.include?(skill)
      end

      tool_events(host, event).each do |tool_event|
        tool_event_id = tool_event["id"]
        next if tool_event_id && seen_tool_event_ids[tool_event_id]

        seen_tool_event_ids[tool_event_id] = true if tool_event_id
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
      runtime_failures << failure if runtime_failure_line?(failure)
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

  def trace_strings(host, event)
    return collect_strings(event) unless host == "claude"
    return [] unless event["type"] == "assistant"

    collect_strings(event.fetch("message", {}))
  end

  def tool_events(host, value, events = [])
    if host == "claude"
      return [] unless value["type"] == "assistant"

      return tool_events_in(value.fetch("message", {}), events)
    end

    tool_events_in(value, events)
  end

  def tool_events_in(value, events = [])
    case value
    when Hash
      events << value if TOOL_TYPES.include?(value["type"])
      value.each_value { |child| tool_events_in(child, events) }
    when Array
      value.each { |child| tool_events_in(child, events) }
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
    return nil unless %w[error failed failure].include?(event["type"].to_s.downcase)

    strings.find { |value| value.match?(/stream disconnected|runtime failure|timed out|failed/i) } || "runtime failure"
  end

  def runtime_failure_line?(line)
    line.match?(/stream disconnected|runtime failure|timed out|\Afatal\b|\Apanic\b|\Aerror:/i)
  end
end
