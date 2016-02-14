/**
 * @license
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// This is a utility class that makes it easier to work with asynchronous tasks.
// Here's why I don't just use Promises:
// (a) I don't want to depend on a Promise implementation.
// (b) Promises aren't cancellable (yet?), and I want cancellability.
//
// This is very stripped down, compared to Promises.
// (a) You can only call .thenDo() once.
// (b) Tasks always complete with a pair (err, result).
// (c) Regardless of errors or cancellation, the argument of .thenDo() is
//     *always* executed, and asynchronously.
// (d) The argument to .thenDo() must return either undefined or a Task. I don't
//     promote values to Tasks, like what happens with Promises.

var Task = exports;

/**
 * Creates a Task.
 *
 * The `doSomething` function is called immediately, so that it can start
 * whatever work is part of this task.
 *
 * The `doSomething` function is given a resolve function and a reject function,
 * and it should call one of them when the task is finished, to report its
 * result.
 *
 * The `doSomething` function can optionally return a cancel function. This will
 * be called if the task is cancelled.
 *
 * @param  {function(function(T), function(?)): function()} doSomething
 * @return {Task<T>}
 * @template T
 */
Task.start = function(doSomething) {
  var me = {};

  // onFinish should be called as soon as both finished and onFinish are
  // defined. It should be called by the piece of code that just defined either
  // finished or onFinish.
  var finished;
  var onFinish;

  function finish(err, result) {
    if (!finished) {
      finished = {err: err, result: result};
      if (onFinish) onFinish();
    }
  }

  try {
    // doSomething must be called immediately.
    var abort = doSomething(
        function(result) { finish(null, result); },
        function(err)    { finish(err,  null);   });
  } catch (err) {
    finish(err, null);
  }

  /**
   * Cancels the task (unless the task has already finished, in which case
   * this call is ignored).
   *
   * If there is a subsequent task scheduled (using #thenDo) it will be called
   * with the pair ('cancelled', null).
   */
  me.cancel = function() {
    if (!finished) {
      finish('cancelled', null);
      if (abort) abort();
    }
  };

  /**
   * Sets the listener that will be called with the result of this task, when
   * finished. This function can be called at most once.
   *
   * @param {function(?, T)} callback
   */
  function setListener(callback) {
    if (onFinish) {
      throw new Error('thenDo/finally called more than once');
    }
    onFinish = function() {
      callback(finished.err, finished.result);
    };
    if (finished) onFinish();
  }

  /**
   * Creates and returns a composite task, consisting of this task and a
   * subsequent task.
   *
   * @param {function(T): ?Task<U>} onResolve A function that will
   *     create a subsequent task. This function will be called
   *     asynchronously, with the result of this task, when it
   *     finishes. The return value must be a Task, or null/undefined.
   * @param {function(?): ?Task<U>} onReject A function that will
   *     create a subsequent task. This function will be called
   *     asynchronously, with the error produced by this task, when it
   *     finishes. The return value must be a Task, or null/undefined.
   * @return {Task<U>} The composite task. Cancelling the composite task cancels
   *     either this task or the subsequent task, depending on whether this
   *     task is finished.
   * @template U
   */
  me.thenDo = function(onResolve, onReject) {
    return compose(me, setListener, onResolve, onReject);
  };

  /**
   * Registers a cleanup function, that will be run when the task finishes,
   * regardless of error or cancellation.
   *
   * @param {function()} cleanup
   * @return {THIS}
   */
  me.finally = function(cleanup) {
    setListener(function() {
      process.nextTick(cleanup);
    });
    return me;
  };

  return me;
};

/**
 * Creates a Task with the given result.
 */
Task.withValue = function(result) {
  return Task.start(function(resolve) {
    resolve(result);
  });
};

/**
 * Creates a composite task, which uses the output of the first task to create
 * a subsequent task, and represents the two tasks together.
 *
 * This function is internal-only. It is used by Task.thenDo().
 *
 * @param {Task<T>} firstTask
 * @param {function(function(?, T))} setFirstTaskListener The private
 *     setListener method on the firstTask.
 * @param {function(T): Task<U>} onResolve
 * @param {function(?): Task<U>} onReject
 * @return {Task<U>}
 * @template T, U
 */
function compose(firstTask, setFirstTaskListener, onResolve, onReject) {
  var cancelled;
  var currentTask = firstTask;
  var resolveCompositeTask, rejectCompositeTask;
  var compositeTask = Task.start(function(resolve, reject) {
    resolveCompositeTask = resolve;
    rejectCompositeTask = reject;
    return function cancelCompositeTask() {
      cancelled = true;
      if (currentTask) {
        currentTask.cancel();
      }
    };
  });

  setFirstTaskListener(function(firstErr, firstResult) {
    currentTask = null;
    // createSubsequentTask must be called asynchronously.
    process.nextTick(function() {
      if (cancelled || firstErr === 'cancelled') {
        rejectCompositeTask('cancelled');
        return;
      }

      try {
        if (firstErr == null) {
          if (onResolve) {
            currentTask = onResolve(firstResult);
          } else {
            resolveCompositeTask(firstResult);
            return;
          }
        } else {
          if (onReject) {
            currentTask = onReject(firstErr);
          } else {
            rejectCompositeTask(firstErr);
            return;
          }
        }
      } catch (err) {
        rejectCompositeTask(err);
        return;
      }

      if (currentTask) {
        currentTask.thenDo(resolveCompositeTask, rejectCompositeTask);
      } else {
        resolveCompositeTask(undefined);
      }
    });
  });

  return compositeTask;
}