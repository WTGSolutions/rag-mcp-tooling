// Package sample demonstrates Go chunking.
package sample

import "fmt"

const Version = "1.0"

// Greet returns a greeting.
func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// Animal is a basic animal.
type Animal struct {
	Name string
}

// Speaker can speak.
type Speaker interface {
	Speak() string
}

// Speak implements Speaker for Animal.
func (a Animal) Speak() string {
	return "..."
}

func (a *Animal) SetName(n string) {
	a.Name = n
}
