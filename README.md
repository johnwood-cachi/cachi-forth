# Cachi-Forth Interpreter

An in-browser, mutation-aware interpreter for **Cachi-Forth**, a toy stack language
built to explore Algorithmic Information Theory dynamics, and for the [CACHI](https://cachi.wiki)
research project. 

## Features
* **Minimal forth-style language** - very simple, stack-based language designed specifically
to a) have no syntactical sugar and b) withstand program mutations.

* **Only outputs numbers** - Purpose is to output a stream of numbers, through defined abstractions like
loops, conditional blocks, functions and multi-threading.

* **Multi-threading** - simple but powerful multi-threading through the branch command, which forks execution.

* **Labelled control blocks** – allows easy tracking of abstractions and their lifetimes.
  
* **Auto-evolver** – random program generator, and continuous mutations (until a label collapses)
  
* **Levenshtein delta** – enforces coherence through levenshtein delta thresholds in output
  
* **Thread-aware call-stack colouring** - to easily visualize which abstraction caused the output of which number, for pattern tracking.

