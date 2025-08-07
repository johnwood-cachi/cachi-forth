## Cachi‑Forth Language Specification

Cachi‑Forth is a minimal, stack-based, postfix language for modeling structural complexity. 

### 🔢 Data Model

Stack: Integer-only

**Execution Limit:** Typically throttled to 10,000 timeslice executions (to prevent halting). During mutation will maintain the SAME steps as an execution limit.

**Output:** Emitted via out, collected in output buffer

### 🧱 Tokens

📥 Literals

Integer literals: e.g. -5, 42

Clamped to range via modulus: [0 - 127]

➕ Arithmetic

> +, -, *, /
Truncated integer math. Division by zero yields 0.

### 🌀 Stack Manipulation

*dup* – duplicate top value

*swap* – swap top two values

*drop* – discard top value

*bit* – increments an internal global counter. When "out" is run, will output and reset the counter if the counter > 0.

*bval* – pushes the bit counter onto the stack, and resets it.

*\@last* - pops TWO values. First pop selects which history buffer to use (0 = most recent, 1 = previous, etc.) from a rolling history of the last 10 runs; second pop selects the index within that selected output (both indices are absoluted and modulused). Pushes the retrieved value (or 0 if missing) onto the stack.

### 📤 Output

*out* – pop and append to output buffer. If the bit counter is > 0, will output and reset the bit counter instead.

### 🔁 Control Flow

> loop ... end

* Pops n; executes body (...) n times

> ifg ... end

* Pops a, b; runs body if b > a (else is not supported)

> ifl ... end

* Pops a, b; runs body if b < a (else is not supported)

> prune

* Pops a; if a < 64 then terminates the current thread of execution. 

### 🌿 Branching
> branch2, branch3, branch4, branch5
* Forks parallel threads using next 2–5 tokens as branch seeds (if seed starts with a control block, the entire block up to 'end' will be considered 1 seed token)

* Each seed token is pushed onto a copy of the current stack

* Each thread runs: [seed-token, remaining tokens]

* Parent thread terminates after forking

### 📦 Functions

> >name ... end

* Define function name consisting of body ...

Functions always reference top 3 stack values as #p1, #p2 and #p3

* Invoked via @name (if function does not exist, it is ignored)

* Function body can invoke other functions, including itself recursively

### Labels

Any control-block command can contain a label, in this format: command:label. For example, loop:mainloop.
Labels cannot contain spaces. Labels are used for commenting and tracking purposes, especially during mutations.

### Protected blocks

Any instructions surrounded by \[ ... \] (with spaces) will not be modified during mutation.

🛡️ Notes

Functions and control blocks may be nested

No dynamic scope or named variables; all state is stack-based (but #p1, #p2 and #p3 can peek the stack).

Cachi-Forth is very forgiving and will not produce runtime errors. Instruction execution limit stops infinite or excessive loops. No programs can be halting.

## PURPOSE:

This language was created to explore Algorithmic Information Theory concepts, such as Kolmogorov complexity and Solomononoff induction.
In particular it was designed to model inference processes via abstractions (functions) and their (conditional) invocation and propagation
of execution. The motivation is for it to let us model and simulate neural processing in the brain and also LLMs.

Technically, Cachi-Forth is Turing-complete (the execution limit is imposed just for practicability).

