package cmd

import "github.com/spf13/cobra"

var rootCmd = &cobra.Command{
	Use:   "floffi",
	Short: "floffi is a small HTTP server CLI",
}

func Execute() error {
	return rootCmd.Execute()
}
