# Architecture

The `src/core` module owns the domain model; `src/utils` carries pure
helpers; `src/web` renders views. Tests import production modules directly.
