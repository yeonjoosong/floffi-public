package main

import (
	"fmt"
	"os"

	"floffi/cmd/floffi/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
