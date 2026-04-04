package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var version = "dev"

func init() {
	rootCmd.AddCommand(versionCmd)
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the build version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println(version)
	},
}
