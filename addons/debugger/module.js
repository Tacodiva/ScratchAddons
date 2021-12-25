const vm = window.__scratchAddonsTraps._onceMap.vm;
const runtime = vm.runtime;

// Constants from
// https://github.com/LLK/scratch-vm/blob/bb352913b57991713a5ccf0b611fda91056e14ec/src/engine/thread.js#L207
const Thread = {
  STATUS_RUNNING: 0,
  STATUS_PROMISE_WAIT: 1,
  STATUS_YIELD: 2,
  STATUS_YIELD_TICK: 3,
  STATUS_DONE: 4,
};

const EVENT_TARGET = new EventTarget();

const Events = {
  PAUSE_CHANGED: "pause_changed",
};

// Are we currently single-stepping through blocks?
// `paused` must be true for this to be true
let singleSteppingBlocks = false;
let paused = false;

/*
 See https://github.com/LLK/scratch-vm/blob/bb352913b57991713a5ccf0b611fda91056e14ec/src/engine/sequencer.js
 */
class ScratchAddonsSequencer {
  constructor(sequencer) {
    this.timer = runtime.sequencer.timer;
    this.activeThread = null;
    this.runtime = runtime;

    // This is normally a variable defined inside stepThreads, but
    //  we need it to be shared between steps while single stepping.
    this.stepRanFirstTick = false;
    this.stepExecutingThread = false;
    this.stepActiveThread = null;

    this.scratchSequencer = sequencer;
    // These methods need to be copied as they are overwriten in the
    //  original sequencer.
    this.scratchSequencerStepToProc = sequencer.stepToProcedure;
    this.scratchSequencerStepToBranch = sequencer.stepToBranch;
  }

  stepToProcedure(...args) {
    this.scratchSequencerStepToProc.call(this, ...args);
  }

  stepToBranch(...args) {
    this.scratchSequencerStepToBranch.call(this, ...args);
  }

  retireThread(...args) {
    this.scratchSequencer.retireThread.call(this, ...args);
  }

  stepThread(...args) {
    this.scratchSequencer.stepThread.call(this, ...args);
  }

  stepThreads() {
    if (singleSteppingBlocks) {
      // return this._singleStepThreads();
    } else {
      return this._defaultStepThreads();
    }
  }

  /*
    We need to call execute(this, thread) like the original sequencer. We don't
    have access to that method, so we need to force the oringal stepThread to run
    execute for us than exit before it tries to run more blocks.

    We can't override thread.status with STATUS_PROMISE_WAIT or STATUS_YIELD_TICK
    becuase of this:
    https://github.com/LLK/scratch-vm/blob/bbd242bbcab719fb0e3e25306ebf5e0b6fc48f4e/src/engine/execute.js#L108

    So, we make `thread.blockGlowInFrame = ...` throw an exception, so this line:
    https://github.com/LLK/scratch-vm/blob/bb352913b57991713a5ccf0b611fda91056e14ec/src/engine/sequencer.js#L214
    will end the function early. We then have to set it back to normal after.

    Why are we here just to suffer?
   */
  _execute(thread) {
    const throwMsg = "Exit scratchSequencer.stepThread early.";
    thread.realBlockGlowInFrame = thread.blockGlowInFrame;
    Object.defineProperty(thread, "blockGlowInFrame", {
      set: function (block) {
        throw throwMsg;
      },
    });

    try {
      this.scratchSequencer.stepThread(thread);
    } catch (err) {
      console.log(err);
      if (err !== throwMsg) throw err; // Just incase another error happens that's not ours.
    }

    Object.defineProperty(thread, "blockGlowInFrame", {
      value: thread.realBlockGlowInFrame,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    delete thread.realBlockGlowInFrame;
  }

  _singleStepThreads() {
    this.runtime.updateCurrentMSecs();

    if (this.activeThread) {
      if (this.stepExecutingThread) {
        const thread = this.activeThread;

        // Executes one block and moves the current block to the next one.
        // If we should swap thread, stop exexuting this thread.
        this.stepExecutingThread = !this._singleStepThread(thread);

        // We didn't finish any threads
        return [];
      } else {
        // We are done executing the current thread :(

        const oldThread = this.activeThread;
        const threadIndex = runtime.threads.indexOf(oldThread);

        // Step 1. If the old thread is finished, remove it.
        if (oldThread.stack.length === 0 || oldThread.pauseInfo.status === Thread.STATUS_DONE) {
          runtime.thread.splice(threadIndex, 1);
        } else {
          ++threadIndex;
        }

        // Step 2. ???

        return [oldThread];
      }
    } else {
      console.log("No active thread to step :(");
    }
  }

  // Returns if we should swap threads.
  _singleStepThread(thread) {
    if (thread.target == null) {
      this.retireThread(thread);
    } else {
      _execute(thread);
    }
    thread.blockGlowInFrame = currentBlockId;

    if (thread.status === Thread.STATUS_YIELD) {
      thread.status = Thread.STATUS_RUNNING;
      return true;
    } else if (thread.status === Thread.STATUS_PROMISE_WAIT || thread.status === Thread.STATUS_YIELD_TICK) {
      return true;
    }

    if (thread.peekStack() === currentBlockId) {
      thread.goToNextBlock();
    }

    // Look on the stack for more blocks for this thread to execute
    while (!thread.peekStack()) {
      thread.popStack();

      if (thread.stack.length === 0) {
        thread.status = Thread.STATUS_DONE;
        return !thread.isWarpMode;
      }

      const stackFrame = thread.peekStackFrame();

      if (stackFrame.isLoop) {
        if (thread.isWarpMode) {
          return true;
        } else {
          continue;
        }
      } else if (stackFrame.waitingReporter) {
        return true;
      }

      thread.goToNextBlock();
    }
  }

  _defaultStepThreads() {
    // Work time is 75% of the thread stepping interval.
    const WORK_TIME = 0.75 * this.runtime.currentStepTime;
    // For compatibility with Scatch 2, update the millisecond clock
    // on the Runtime once per step (see Interpreter.as in Scratch 2
    // for original use of `currentMSecs`)
    this.runtime.updateCurrentMSecs();
    // Start counting toward WORK_TIME.
    this.timer.start();
    // Count of active threads.
    let numActiveThreads = Infinity;
    // Whether `stepThreads` has run through a full single tick.
    var ranFirstTick = false;
    const doneThreads = [];
    
    var startIdx = 0;
    // If paused thread is set, we paused half way though executing a thread.
    // If that thread is no longer paused, start executing from it again.
    if (this.stepActiveThread && !this.stepActiveThread.pauseInfo) {
        startIdx = this.runtime.threads.indexOf(this.stepActiveThread);
        if (startIdx == -1) startIdx = 0; // Just in case something weird happens
        this.stepActiveThread = null;
    }

    // Conditions for continuing to stepping threads:
    // 1. We must have threads in the list, and some must be active.
    // 2. Time elapsed must be less than WORK_TIME.
    // 3. Either turbo mode, or no redraw has been requested by a primitive.
    while (
      this.runtime.threads.length > 0 &&
      numActiveThreads > 0 &&
      this.timer.timeElapsed() < WORK_TIME &&
      (this.runtime.turboMode || !this.runtime.redrawRequested)
    ) {
      numActiveThreads = 0;
      let stoppedThread = false;

      // Attempt to run each thread one time.
      const threads = this.runtime.threads;

      for (let i = startIdx; i < threads.length; i++) {
        const activeThread = (this.activeThread = threads[i]);

        if (activeThread.stack.length === 0 || activeThread.status === Thread.STATUS_DONE) {
          // Is thead finished
          stoppedThread = true;
          continue;
        }
        if (
          activeThread.status === Thread.STATUS_YIELD_TICK && // Was thead yeilding for only one tick?
          !ranFirstTick
        ) {
          activeThread.status = Thread.STATUS_RUNNING;
        }

        // Don't run thread if paused
        if (activeThread.pauseInfo) {
            continue;
        }

        if (activeThread.status === Thread.STATUS_RUNNING || activeThread.status === Thread.STATUS_YIELD) {
          this.stepThread(activeThread);

          activeThread.warpTimer = null;
          if (activeThread.isKilled) {
            i--; // if the thread is removed from the list (killed), do not increase index
          }

          if (activeThread.pauseInfo) {
            // A breakpoint block was hit. While executing the thread.
            // We need to remember the active thread so we can return to it
            // when we unpause.
            this.stepActiveThread = activeThread;
            this.stepRanFirstTick = ranFirstTick;
            this.stepExecutingThread = false;

            // Our status was forcibly set to STATUS_PROMISE_WAIT. Set
            //  it back to normal.
            Object.defineProperty(activeThread, "status", {
                value: activeThread.pauseInfo.status,
                configurable: true,
                enumerable: true,
                writable: true,
            });
            delete activeThread.pauseInfo.status;

            continue;
          }
        }

        if (activeThread.status === Thread.STATUS_RUNNING) {
          numActiveThreads++;
        }

        // Check if the thread completed while it just stepped to make
        // sure we remove it before the next iteration of all threads.
        if (activeThread.stack.length === 0 || activeThread.status === Thread.STATUS_DONE) {
          // Finished with this thread.
          stoppedThread = true;
        }
      }
      // We successfully ticked once. Prevents running STATUS_YIELD_TICK
      // threads on the next tick.
      ranFirstTick = true;

      // Filter inactive threads from `this.runtime.threads`.
      if (stoppedThread) {
        let nextActiveThread = 0;
        for (let i = 0; i < this.runtime.threads.length; i++) {
          const thread = this.runtime.threads[i];
          if (thread.stack.length !== 0 && thread.status !== Thread.STATUS_DONE) {
            this.runtime.threads[nextActiveThread] = thread;
            nextActiveThread++;
          } else {
            doneThreads.push(thread);
          }
        }
        this.runtime.threads.length = nextActiveThread;
      }

      startIdx = 0;
    }

    this.activeThread = null;

    return doneThreads;
  }
}

/*
    As a speed and bug-reducing procaution, the ScratchAddonsSequencer
    should only be used when we actually need to use it.
    IE When we are paused. 

    TODO Re-enable the scratch sequencer when we can.
*/

const scratchSequencer = runtime.sequencer;
runtime.sequencer = new ScratchAddonsSequencer(scratchSequencer);
// We have to do these because BlockUtility keeps a copy of the original sequencer
//  and we don't have access to execute's instance of BlockUtility :(
scratchSequencer.stepToBranch = (...args) => runtime.sequencer.stepToBranch(...args);
scratchSequencer.stepToProcedure = (...args) => runtime.sequencer.stepToProcedure(...args);

export function isPaused() {
  return paused;
}

export function onPauseChanged(listener) {
  EVENT_TARGET.addEventListener(Events.PAUSE_CHANGED, () => listener(paused));
}

export function setPaused(_paused) {
  if (_paused) {
    if (!paused) {
      // Pause
      vm.runtime.audioEngine.audioContext.suspend();
      if (!vm.runtime.ioDevices.clock._paused) {
        vm.runtime.ioDevices.clock.pause();
      }

      for (const thread of runtime.threads) {
        if (!thread.updateMonitor && !thread.pauseInfo) {
          const pauseInfo = {
            time: runtime.currentMSecs,
          };

          thread.pauseInfo = pauseInfo;
        }
      }

      // If we where running a thread when we hit the breakpoint, we
      //  need to get that thread to stop stepping instantly.
      if (runtime.sequencer.activeThread) {
          const thread = runtime.sequencer.activeThread;

          thread.pauseInfo.status = thread.status;
          Object.defineProperty(thread, "status", {
              get: function () {
                  return Thread.STATUS_PROMISE_WAIT;
              },
              set: function (status) {
                  this.pauseInfo.status = status;
              }
          });
      }
    }
  } else {
    if (paused) {
      // Unpause

      vm.runtime.audioEngine.audioContext.resume();
      vm.runtime.ioDevices.clock.resume();

      const now = Date.now();
      for (const thread of runtime.threads) {
        if (thread.pauseInfo) {
          // If the thread is waiting on a timer (like for threads on a sleep block),
          //  make it so their timers havn't had any time pass sense they where paused.
          const stackFrame = thread.peekStackFrame();
          if (stackFrame && stackFrame.executionContext && stackFrame.executionContext.timer) {
            stackFrame.executionContext.timer.startTime += now - thread.pauseInfo.time;
          }

          delete thread.pauseInfo;
        }
      }
    }
  }
  if (paused != _paused) {
    paused = _paused;
    EVENT_TARGET.dispatchEvent(new CustomEvent(Events.PAUSE_CHANGED));
  }
}

export function singleStep() {}

// Unpause when green flag clicked
const originalGreenFlag = vm.runtime.greenFlag;
vm.runtime.greenFlag = function () {
  setPaused(false);
  return originalGreenFlag.call(this);
};

// Disable edge-activated hats and hats like "when key pressed" while paused.
const originalStartHats = vm.runtime.startHats;
vm.runtime.startHats = function (...args) {
  if (paused) {
    const hat = args[0];
    // The project can still be edited and the user might manually trigger some events. Let these run.
    if (hat !== "event_whenbroadcastreceived" && hat !== "control_start_as_clone") {
      return [];
    }
  }
  return originalStartHats.apply(this, args);
};

// Paused threads should not be counted as running when updating GUI state.
const originalGetMonitorThreadCount = vm.runtime._getMonitorThreadCount;
vm.runtime._getMonitorThreadCount = function (threads) {
  let count = originalGetMonitorThreadCount.call(this, threads);
  if (paused) {
    for (const thread of threads) {
      if (thread.pauseInfo) {
        count++;
      }
    }
  }
  return count;
};
