package session

import "github.com/pocketctl/pocketctl/internal/config"

// Keep argv[0] intact, including interpreter-backed native agent launchers.
func applyManagedTaskToolsCommand(agent string, argv, env []string) ([]string, []string, error) {
	args, env, err := config.ApplyTaskTools(agent, argv[1:], env)
	if err != nil {
		return nil, nil, err
	}
	return append([]string{argv[0]}, args...), env, nil
}
