// 存储副作用函数的桶
const bucket = new WeakMap();
const ITERATE_KEY = Symbol("iterate");

const TriggerType = {
  SET: "SET",
  ADD: "ADD",
  DELETE: "DELETE",
};

// 对原始数据的代理
export function reactive(obj) {
  return new Proxy(obj, {
    // 拦截读取操作
    get(target, key, receiver) {
      // 将副作用函数 activeEffect 添加到存储副作用函数的桶中
      track(target, key);
      // 返回属性值
      return Reflect.get(target, key, receiver);
    },
    // 拦截设置操作
    set(target, key, newVal, receiver) {
      const type = Object.prototype.hasOwnProperty.call(target, key)
        ? TriggerType.SET
        : TriggerType.ADD;
      // 设置属性值
      Reflect.set(target, key, newVal, receiver);
      // 把副作用函数从桶里取出并执行
      trigger(target, key, type);
    },
    has(target, key) {
      track(target, key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      track(target, ITERATE_KEY);
      return Reflect.ownKeys(target);
    },
    deleteProperty(target, key) {
      const hasKey = Object.prototype.hasOwnProperty.call(target, key);
      const res = Reflect.deleteProperty(target, key);
      if (res && hasKey) {
        trigger(target, key, TriggerType.DELETE);
      }
      return res;
    },
  });
}

function track(target, key) {
  if (!activeEffect) return;
  let depsMap = bucket.get(target);
  if (!depsMap) {
    bucket.set(target, (depsMap = new Map()));
  }
  let deps = depsMap.get(key);
  if (!deps) {
    depsMap.set(key, (deps = new Set()));
  }
  deps.add(activeEffect);
  activeEffect.deps.push(deps);
}

function trigger(target, key, type) {
  const depsMap = bucket.get(target);
  if (!depsMap) return;
  const effects = depsMap.get(key);
  const iterateEffects = depsMap.get(ITERATE_KEY);

  const effectsToRun = new Set();
  effects &&
    effects.forEach((effectFn) => {
      if (effectFn !== activeEffect) {
        effectsToRun.add(effectFn);
      }
    });

  if (type === TriggerType.ADD || type === TriggerType.DELETE) {
    iterateEffects &&
      iterateEffects.forEach((effectFn) => {
        if (effectFn != activeEffect) {
          effectsToRun.add(effectFn);
        }
      });
  }

  effectsToRun.forEach((effectFn) => {
    if (effectFn.options.scheduler) {
      effectFn.options.scheduler(effectFn);
    } else {
      effectFn();
    }
  });
  // effects && effects.forEach(effectFn => effectFn())
}

// 用一个全局变量存储当前激活的 effect 函数
let activeEffect;
// effect 栈
const effectStack = [];

export function effect(fn, options = {}) {
  const effectFn = () => {
    cleanup(effectFn);
    // 当调用 effect 注册副作用函数时，将副作用函数复制给 activeEffect
    activeEffect = effectFn;
    // 在调用副作用函数之前将当前副作用函数压栈
    effectStack.push(effectFn);
    // 保存当前副作用函数的返回值res
    const res = fn();
    // 在当前副作用函数执行完毕后，将当前副作用函数弹出栈，并还原 activeEffect 为之前的值
    effectStack.pop();
    activeEffect = effectStack[effectStack.length - 1];
    // 将res作为effectFn的返回值
    return res;
  };
  // 将 options 挂在到 effectFn 上
  effectFn.options = options;
  // activeEffect.deps 用来存储所有与该副作用函数相关的依赖集合
  effectFn.deps = [];
  // 执行副作用函数
  if (!options.lazy) {
    effectFn();
  }

  return effectFn;
}

function cleanup(effectFn) {
  for (let i = 0; i < effectFn.deps.length; i++) {
    const deps = effectFn.deps[i];
    deps.delete(effectFn);
  }
  effectFn.deps.length = 0;
}

// =========================

export function watch(getter, fn, options) {
  let oldVal, newVal, effectFn;

  let cleanup = null;

  function onInvalidate(fn) {
    cleanup = fn;
  }

  function job() {
    cleanup && cleanup() && (cleanup = null);
    newVal = effectFn();
    fn(newVal, oldVal, onInvalidate);
    oldVal = newVal;
  }
  effectFn = effect(
    () => {
      if (typeof getter === "function") {
        return getter();
      } else if (typeof getter === "object") {
        console.log(getter);
        return traverse(getter);
      }
    },
    {
      lazy: true,
      scheduler: () => {
        if (options?.flush) {
          Promise.resolve().then(job);
        } else {
          job();
        }
      },
    }
  );
  if (options?.immediate) {
    job();
  } else {
    effectFn();
  }
}

function traverse(value, seen = new Set()) {
  if (typeof value != "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const k in value) {
    traverse(value[k], seen);
  }
  return value;
}

export function computed(getter) {
  let value;
  let dirty = true;

  const effectFn = effect(getter, {
    lazy: true,
    scheduler() {
      if (!dirty) {
        // 将dirty设置为true，表示当前值已经变化，需要重新计算
        dirty = true;
        // 当computed的getter的属性发生变化时，执行trigger告知computed的依赖发生变化让他们重新执行
        trigger(obj, "value");
      }
    },
  });

  const obj = {
    get value() {
      // 读取数据的时候，如果发现dirty值为true，则说明computed依赖发生变化了，需要重新执行
      // 否则使用缓存的数据
      if (dirty) {
        value = effectFn();
        dirty = false;
      }
      // 当读取一个计算属性的值时，调用track收集依赖
      track(obj, "value");
      return value;
    },
  };

  return obj;
}
