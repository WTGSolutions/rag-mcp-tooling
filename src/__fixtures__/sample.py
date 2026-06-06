"""Module docstring."""
import os
import sys

MODULE_CONST = 42


# Helper function with leading comment
def greet(name: str) -> str:
    """Return a greeting."""
    return f"Hello, {name}!"


def add(a: int, b: int) -> int:
    return a + b


class Animal:
    """Base animal class."""

    def __init__(self, name: str) -> None:
        self.name = name

    def speak(self) -> str:
        raise NotImplementedError

    def __repr__(self) -> str:
        return f"Animal({self.name!r})"


class Dog(Animal):
    """A dog."""

    def speak(self) -> str:
        return "Woof!"

    @staticmethod
    def species() -> str:
        return "Canis lupus familiaris"


def standalone_at_end() -> None:
    pass
