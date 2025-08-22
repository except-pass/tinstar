"""Tests for the Tinstar installation module."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from tinstar.installation.installer import (
    merge_hooks,
    purge_tinstar_hooks,
    template_hooks_json,
)


class TestMergeHooks:
    """Test the merge_hooks function to prevent duplicate hook regressions."""

    def test_merge_hooks_no_duplicates_on_repeat_calls(self):
        """Test that running merge_hooks multiple times doesn't create duplicates."""
        # Initial settings with some existing hooks
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": []
                    }
                ]
            }
        }
        
        # New hooks to merge (simulating tinstar hooks)
        new_hooks = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo 'test' #TINSTAR"
                            }
                        ]
                    }
                ]
            }
        }
        
        # First merge
        merge_hooks(settings, new_hooks)
        first_merge_count = len(settings["hooks"]["PreToolUse"])
        first_merge_cmd_count = len(settings["hooks"]["PreToolUse"][0]["hooks"])
        
        # Second merge (should not create duplicates)
        merge_hooks(settings, new_hooks)
        second_merge_count = len(settings["hooks"]["PreToolUse"])
        second_merge_cmd_count = len(settings["hooks"]["PreToolUse"][0]["hooks"])
        
        # Should not have increased after second merge
        assert first_merge_count == second_merge_count
        assert first_merge_cmd_count == second_merge_cmd_count
        assert second_merge_cmd_count == 1  # Only one command should exist

    def test_merge_hooks_different_matchers(self):
        """Test that hooks with different matchers are kept separate."""
        settings = {"hooks": {}}
        
        new_hooks = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "{\"tool_name\":\"TodoWrite\"}",
                        "hooks": [
                            {"type": "command", "command": "todo command #TINSTAR"}
                        ]
                    },
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "general command #TINSTAR"}
                        ]
                    }
                ]
            }
        }
        
        merge_hooks(settings, new_hooks)
        
        # Should have 2 different hook entries
        assert len(settings["hooks"]["PreToolUse"]) == 2
        
        # Find the TodoWrite matcher
        todo_hook = next(h for h in settings["hooks"]["PreToolUse"] 
                        if h["matcher"] == "{\"tool_name\":\"TodoWrite\"}")
        general_hook = next(h for h in settings["hooks"]["PreToolUse"] 
                           if h["matcher"] == "")
        
        assert len(todo_hook["hooks"]) == 1
        assert len(general_hook["hooks"]) == 1
        assert "todo command" in todo_hook["hooks"][0]["command"]
        assert "general command" in general_hook["hooks"][0]["command"]

    def test_merge_hooks_same_matcher_different_commands(self):
        """Test merging commands into existing hook with same matcher."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "existing command"}
                        ]
                    }
                ]
            }
        }
        
        new_hooks = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "new command #TINSTAR"}
                        ]
                    }
                ]
            }
        }
        
        merge_hooks(settings, new_hooks)
        
        # Should still have only 1 hook entry (same matcher)
        assert len(settings["hooks"]["PreToolUse"]) == 1
        
        # But should have 2 commands
        commands = settings["hooks"]["PreToolUse"][0]["hooks"]
        assert len(commands) == 2
        assert any("existing command" in cmd["command"] for cmd in commands)
        assert any("new command" in cmd["command"] for cmd in commands)

    def test_merge_hooks_exact_duplicate_commands(self):
        """Test that exact duplicate commands are not added."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "same command #TINSTAR"}
                        ]
                    }
                ]
            }
        }
        
        new_hooks = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "same command #TINSTAR"}
                        ]
                    }
                ]
            }
        }
        
        merge_hooks(settings, new_hooks)
        
        # Should still have only 1 command (no duplicate)
        commands = settings["hooks"]["PreToolUse"][0]["hooks"]
        assert len(commands) == 1
        assert commands[0]["command"] == "same command #TINSTAR"


class TestPurgeTinstarHooks:
    """Test the purge_tinstar_hooks function."""

    def test_purge_removes_tinstar_commands(self):
        """Test that purge correctly removes commands with #TINSTAR."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "keep this command"},
                            {"type": "command", "command": "remove this #TINSTAR"},
                            {"type": "command", "command": "also remove #TINSTAR"}
                        ]
                    }
                ]
            }
        }
        
        purge_tinstar_hooks(settings)
        
        commands = settings["hooks"]["PreToolUse"][0]["hooks"]
        assert len(commands) == 1
        assert commands[0]["command"] == "keep this command"

    def test_purge_preserves_non_tinstar_commands(self):
        """Test that purge preserves commands without #TINSTAR."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "",
                        "hooks": [
                            {"type": "command", "command": "user command 1"},
                            {"type": "command", "command": "user command 2"}
                        ]
                    }
                ]
            }
        }
        
        original_count = len(settings["hooks"]["PreToolUse"][0]["hooks"])
        purge_tinstar_hooks(settings)
        
        # Should preserve all commands
        commands = settings["hooks"]["PreToolUse"][0]["hooks"]
        assert len(commands) == original_count
        assert all("#TINSTAR" not in cmd["command"] for cmd in commands)


class TestTemplateHooksJson:
    """Test the template_hooks_json function."""

    def test_template_hooks_json_paths(self):
        """Test that template_hooks_json correctly replaces paths."""
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            hooks_file = temp_path / "hooks.json"
            logs_dir = temp_path / "logs"
            logs_dir.mkdir()
            
            # Create test hooks file with template paths
            test_hooks = {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "",
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": "echo >> /home/ubuntu/repo/ctrltower/logs/activity-log.jsonl"
                                }
                            ]
                        }
                    ]
                }
            }
            
            hooks_file.write_text(json.dumps(test_hooks))
            
            result = template_hooks_json(hooks_file, logs_dir)
            
            # Check that the path was templated correctly
            command = result["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            expected_path = str((logs_dir / "activity-log.jsonl").resolve())
            assert expected_path in command
            assert "/home/ubuntu/repo/ctrltower/logs/activity-log.jsonl" not in command


def test_install_regression_multiple_runs():
    """Integration test: ensure multiple install runs don't create duplicates."""
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        claude_settings = temp_path / "settings.json"
        
        # Mock the get_install_paths to use our temp directory
        mock_paths = {
            "claude_settings": claude_settings,
            "claude_settings_backup": claude_settings.with_suffix(".backup"),
            "default_hooks_src": Path(__file__).parent / "hooks.json",
            "logs_dir": temp_path / "logs",
            "worktrees_dir": temp_path / "worktrees"
        }
        
        # Create logs directory
        mock_paths["logs_dir"].mkdir()
        mock_paths["worktrees_dir"].mkdir()
        
        with patch('tinstar.installation.installer.get_install_paths', return_value=mock_paths):
            with patch('tinstar.installation.installer.backup_existing_settings', return_value=True):
                with patch('tinstar.installation.installer.bootstrap_directories'):
                    with patch('tinstar.installation.installer.copy_default_config_if_missing'):
                        with patch('tinstar.installation.installer.initialize_sqlite_db'):
                            from tinstar.installation.installer import install
                            
                            # Run install twice
                            install()
                            first_run_content = claude_settings.read_text()
                            
                            install()
                            second_run_content = claude_settings.read_text()
                            
                            # Parse JSON to compare structure
                            first_settings = json.loads(first_run_content)
                            second_settings = json.loads(second_run_content)
                            
                            # Should be identical after second run
                            assert first_settings == second_settings
                            
                            # Verify no duplicate empty matchers
                            for event_type, hooks in first_settings.get("hooks", {}).items():
                                empty_matchers = [h for h in hooks if h.get("matcher") == ""]
                                assert len(empty_matchers) <= 1, f"Multiple empty matchers found in {event_type}"