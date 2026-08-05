#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require_relative "run_full_baseline"

class RunFullBaselineTest < Minitest::Test
  def test_route_only_instruction_requires_router_for_direct_requests
    instruction = route_only_instruction(
      "fake_home" => "/fixture/home",
      "route_input_path" => "/fixture/route-input.json"
    )

    assert_includes instruction, "mandatory for every user request"
    assert_includes instruction, "including a direct, trivial, translation, or no-skill request"
    assert_match(/evaluation harness\s+infrastructure, not a workflow skill/, instruction)
  end
end
