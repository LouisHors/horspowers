#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require_relative "run_full_baseline"

class RunFullBaselineTest < Minitest::Test
  def fixture
    {
      "fake_home" => "/fixture/home",
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
end
