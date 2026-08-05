#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require_relative "host_trace_parser"

class HostTraceParserTest < Minitest::Test
  def test_parses_codex_jsonl_router_trace
    stdout = <<~JSONL
      {"type":"item.completed","item":{"type":"command_execution","command":"node /fixture/route-request.mjs","aggregated_output":"{\\"routing\\":{\\"route\\":\\"planning\\",\\"target_skill\\":\\"horspowers:writing-plans\\"}}"}}
      {"type":"item.completed","item":{"type":"message","text":"Loaded horspowers:writing-plans."}}
    JSONL

    result = HostTraceParser.parse(host: "codex", stdout: stdout, stderr: "")

    assert_equal 1, result.router_calls
    assert_equal "planning", result.router_json.fetch("route")
    assert_equal "horspowers:writing-plans", result.router_json.fetch("target_skill")
    assert_equal ["horspowers:writing-plans"], result.target_skill_mentions
    assert_equal 0, result.qmd_calls
    assert_equal 0, result.other_tool_calls
    assert_empty result.runtime_failures
  end

  def test_deduplicates_codex_started_and_completed_router_events_and_ignores_nonfatal_warnings
    stdout = <<~JSONL
      {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the skills context budget."}}
      {"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"node /fixture/route-request.mjs","status":"in_progress"}}
      {"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"node /fixture/route-request.mjs","aggregated_output":"{\\"routing\\":{\\"route\\":\\"direct\\",\\"target_skill\\":null}}","status":"completed"}}
    JSONL
    stderr = "2026-08-05T13:37:36Z  WARN codex_core_plugins: remote plugin sync failed\n"

    result = HostTraceParser.parse(host: "codex", stdout: stdout, stderr: stderr)

    assert_equal 1, result.router_calls
    assert_equal "direct", result.router_json.fetch("route")
    assert_empty result.runtime_failures
  end

  def test_parses_claude_stream_json_direct_trace_without_tools_after_router
    stdout = <<~JSONL
      {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"node /fixture/route-request.mjs"}}]}}
      {"type":"user","message":{"content":[{"type":"tool_result","content":"{\\"routing\\":{\\"route\\":\\"direct\\",\\"target_skill\\":null}}"}]}}
    JSONL

    result = HostTraceParser.parse(host: "claude", stdout: stdout, stderr: "")

    assert_equal 1, result.router_calls
    assert_equal "direct", result.router_json.fetch("route")
    assert_nil result.router_json.fetch("target_skill")
    assert_empty result.target_skill_mentions
    assert_equal 0, result.qmd_calls
    assert_equal 0, result.other_tool_calls
    assert_empty result.runtime_failures
  end

  def test_counts_qmd_as_over_trigger_evidence_separately_from_other_tools
    stdout = <<~JSONL
      {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"qmd search 'router design' -c my-code-wiki -n 8"}}]}}
    JSONL

    result = HostTraceParser.parse(host: "claude", stdout: stdout, stderr: "")

    assert_equal 0, result.router_calls
    assert_nil result.router_json
    assert_equal 1, result.qmd_calls
    assert_equal 0, result.other_tool_calls
  end

  def test_ignores_skill_names_and_tool_like_text_in_system_hook_events
    stdout = <<~JSONL
      {"type":"system","subtype":"hook_response","output":"Injected horspowers:using-horspowers and horspowers:writing-plans."}
      {"type":"assistant","message":{"content":[{"type":"text","text":"Route is direct."}]}}
    JSONL

    result = HostTraceParser.parse(host: "claude", stdout: stdout, stderr: "")

    assert_empty result.target_skill_mentions
    assert_equal 0, result.router_calls
    assert_equal 0, result.qmd_calls
    assert_equal 0, result.other_tool_calls
  end

  def test_counts_only_assistant_tool_use_events_for_claude
    stdout = <<~JSONL
      {"type":"system","subtype":"hook_response","output":"tool_use qmd search should not count"}
      {"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"qmd search 'router'"}}]}}
    JSONL

    result = HostTraceParser.parse(host: "claude", stdout: stdout, stderr: "")

    assert_equal 1, result.qmd_calls
    assert_equal 0, result.other_tool_calls
  end

  def test_counts_unrelated_tool_calls
    stdout = <<~JSONL
      {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status --short"}}]}}
    JSONL

    result = HostTraceParser.parse(host: "claude", stdout: stdout, stderr: "")

    assert_equal 1, result.other_tool_calls
    assert_equal 0, result.qmd_calls
    assert_equal 0, result.router_calls
  end

  def test_records_runtime_and_malformed_trace_failures_without_raising
    stdout = <<~TRACE
      {"type":"error","error":{"message":"stream disconnected"}}
      not-json
    TRACE

    result = HostTraceParser.parse(host: "codex", stdout: stdout, stderr: "runtime failure")

    assert_includes result.runtime_failures, "stream disconnected"
    assert_includes result.runtime_failures, "runtime failure"
    assert_includes result.runtime_failures, "malformed trace line 2"
  end
end
