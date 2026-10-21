package main

import (
	"fmt"
	"io"
	"os"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/i18n"
)

func cmdTaskTools(args []string) {
	if err := runTaskTools(args, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runTaskTools(args []string, out io.Writer) error {
	if len(args) == 1 && (args[0] == "help" || args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(out, i18n.T("task_tools.help"))
		return nil
	}
	if len(args) == 0 {
		args = []string{"status"}
	}
	action := args[0]
	if len(args) > 2 || (action != "status" && action != "enable" && action != "disable" && action != "reset") {
		return fmt.Errorf("%s", i18n.T("task_tools.help"))
	}
	agents := []string{"codex", "claude-code"}
	if len(args) == 2 {
		agent, err := config.TaskToolsAgent(args[1])
		if err != nil {
			return err
		}
		agents = []string{agent}
	} else if action != "status" {
		return fmt.Errorf("%s", i18n.T("task_tools.help"))
	}
	if action != "status" {
		var value *bool
		if action != "reset" {
			enabled := action == "enable"
			value = &enabled
		}
		if err := config.SaveTaskTools(agents[0], value); err != nil {
			return err
		}
	}
	for _, agent := range agents {
		value, err := config.LoadTaskTools(agent)
		if err != nil {
			return err
		}
		state := "inherit"
		if value != nil {
			state = "disabled"
			if *value {
				state = "enabled"
			}
		}
		path, err := config.TaskToolsPath(agent)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, i18n.T("task_tools.status", agent, state, path))
	}
	fmt.Fprintln(out, i18n.T("task_tools.boundary"))
	return nil
}
