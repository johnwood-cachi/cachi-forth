// Fix for mapN synchronization
// This patch should be applied to interpreter.htm

// 1. Add these fields to the initial thread object (around line 510-519):
/*
		waitingFor: [],  // Array of child thread IDs this thread is waiting for
		parentThread: null,  // Parent thread ID for map children
		isMapChild: false,  // Flag to indicate this is a map child thread
		mapResults: []  // Store results from child threads
*/

// 2. Replace the mapN implementation (around lines 851-913) with:
/*
			// Handle map2, map3, map4, map5 instructions
			if (tok.startsWith("map") && tok.length === 4) {
				const N = +tok[3];
				if (N >= 2 && N <= 5) {
					// Pop N values from the stack
					const values = [];
					for (let i = 0; i < N; i++) {
						values.unshift(pop()); // unshift to maintain stack order
					}
					
					// Save the current stack state after popping values
					const baseStack = [...S];
					
					// Collect the next instruction/block
					const seedStartIndex = frameRef.idx;
					const seed = collectSeed(frameRef);
					
					// Remove the collected seed from the current frame
					const start = seedStartIndex;
					const end = frameRef.idx;
					frameRef.tokens.splice(start, end - start);
					frameRef.indices.splice(start, end - start);
					frameRef.idx = start;
					
					// If operating on main stream, adjust pc
					if (frameRef.tokens === th.tokens) {
						th.pc = start;
					}
					
					// Create child thread IDs
					const childThreadIds = [];
					
					// For each value, create a thread with the base stack plus the value
					for (let i = 0; i < values.length; i++) {
						const value = values[i];
						
						// Clone thread with base stack state for all values
						const clone = JSON.parse(JSON.stringify(th));
						// Reset clone's stack to base state and add the value
						clone.stack = [...baseStack, value];
						
						// Insert seed tokens
						const top = clone.blockStack.length ? clone.blockStack[clone.blockStack.length - 1]
						                                    : { tokens: clone.tokens, indices: clone.indices, idx: start };
						top.tokens.splice(top.idx, 0, ...seed.tokens);
						top.indices.splice(top.idx, 0, ...seed.indices);
						
						clone.pc = start;
						clone.id = nextThreadId++;
						clone.parentThread = th.id;
						clone.isMapChild = true;
						clone.waitingFor = [];
						clone.mapResults = [];
						
						childThreadIds.push(clone.id);
						threads.push(clone);
					}
					
					// Set the current thread to wait for all children
					th.waitingFor = childThreadIds;
					th.mapResults = [];
					
					// Skip to end of current frame since we're waiting
					frameRef.idx = frameRef.tokens.length;
					if (frameRef.tokens === th.tokens) {
						th.pc = th.tokens.length;
					}
				}
				if (!dryRun) EXECUTION_TRACE.push({ tid: th.id, ip: origIndex, stack: S.join("|"), callStack: (th.callStack && th.callStack.length ? th.callStack.join("|") : "") });
				continue;
			}
*/

// 3. Add this check at the beginning of the thread loop (after "const th = threads[tid]"):
/*
			// Skip threads that are waiting for children
			if (th.waitingFor && th.waitingFor.length > 0) {
				continue;
			}
*/

// 4. Replace thread termination logic (around line 636) with:
/*
					if (th.pc >= th.tokens.length) {
						// If this is a map child, pass result back to parent
						if (th.isMapChild && th.parentThread !== null) {
							// Find parent thread
							const parentIdx = threads.findIndex(t => t.id === th.parentThread);
							if (parentIdx !== -1) {
								const parent = threads[parentIdx];
								// Push the last value on child's stack to parent's results
								if (S.length > 0) {
									parent.mapResults.push(S[S.length - 1]);
								}
								// Remove this child from parent's waiting list
								parent.waitingFor = parent.waitingFor.filter(id => id !== th.id);
								// If parent is no longer waiting, push all results to its stack
								if (parent.waitingFor.length === 0) {
									// Push results in order they were collected
									for (const result of parent.mapResults) {
										parent.stack.push(result);
									}
									parent.mapResults = [];
								}
							}
						}
						
						threads.splice(tid, 1);
						tid--;
						tok = null;
						break;
					}
*/

// 5. Also update the clone creation in branch instructions (around line 837) to include new fields:
/*
      clone.waitingFor = [];
      clone.parentThread = null;
      clone.isMapChild = false;
      clone.mapResults = [];
*/