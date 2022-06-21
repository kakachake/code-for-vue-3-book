// 存储副作用函数的桶
const bucket = new WeakMap();
const ITERATE_KEY = Symbol("iterate");
const RAW_KEY = Symbol("row");
const reactiveMap = new Map();

const arrayInstrumentations = {};

// 针对数组查找的方法，由于用户可能使用代理后的元素，也可能使用未被代理的元素，故需要重写以下方法
["includes", "indexOf", "lastIndexOf"].forEach((method) => {
  // 先获取到原始的方法
  const originMethod = Array.prototype[method];
  arrayInstrumentations[method] = function (...args) {
    // 首先在代理对象中查找
    const res = originMethod.apply(this, args);

    // 如果不存在，则在原始对象中查找
    if (res === false || res === -1) {
      res = originMethod.apply(this[RAW_KEY], args);
    }

    // 返回最终的结果
    return res;
  };
});

const TriggerType = {
  SET: "SET",
  ADD: "ADD",
  DELETE: "DELETE",
};

// 对原始数据的代理
export function createReactive(obj, isShallow = false, isReadonly = false) {
  return new Proxy(obj, {
    // 拦截读取操作
    get(target, key, receiver) {
      // 代理对象可以通过RAW_KEY获取到原始数据
      // 如：child[RAW_KEY] === obj
      if (key === RAW_KEY) {
        return target;
      }

      if (Array.isArray(target) && arrayInstrumentations.hasOwnProperty(key)) {
        console.log(key);
        return Reflect.get(arrayInstrumentations, key, receiver);
      }

      if (!isReadonly && typeof key !== "symbol") {
        // 将副作用函数 activeEffect 添加到存储副作用函数的桶中
        track(target, key);
      }

      const res = Reflect.get(target, key, receiver);
      // 如果是浅响应，则直接返回res，注意此时的res是非响应式的
      // console.log(isShallow);
      if (isShallow) {
        return res;
      }

      //如果是深响应，则递归将res变为响应式
      if (typeof res === "object" && res !== null) {
        // 递归调用reactive将结果包装成响应式数据并返回

        return isReadonly ? readonly(res) : reactive(res);
      }

      // 返回属性值
      return res;
    },
    // 拦截设置操作
    set(target, key, newVal, receiver) {
      if (isReadonly) {
        console.warn(`属性${key}是只读的`);
        return true;
      }
      // console.log("proxy.set：", "原始对象obj：", target);
      // console.log("proxy.set：", "代理对象child：", receiver);
      // 先获取旧值
      const oldVal = target[key];

      const type = Array.isArray(target)
        ? Number(key) < target.length
          ? TriggerType.SET
          : TriggerType.ADD
        : Object.prototype.hasOwnProperty.call(target, key)
        ? TriggerType.SET
        : TriggerType.ADD;
      // 设置属性值
      const res = Reflect.set(target, key, newVal, receiver);
      // 把副作用函数从桶里取出并执行
      // target === receiver[RAW_KEY]说明就是target的代理对象
      if (target === receiver[RAW_KEY]) {
        // 比较新值和旧值，只有当他们不全等，且都不是NaN时才触发响应
        // NaN === NaN // false
        if (oldVal !== newVal && (oldVal === oldVal || newVal === newVal)) {
          trigger(target, key, type, newVal);
        }
      }
      return res;
    },
    has(target, key) {
      track(target, key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      track(target, Array.isArray(target) ? "length" : ITERATE_KEY);
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

// 深层响应
export function reactive(obj) {
  // 优先通过原始对象 obj 寻找之前创建的代理对象，如果找到了，直接返回已经代理的对象
  const existProxy = reactiveMap.get(obj);
  if (existProxy) {
    return existProxy;
  }

  // 否则，创建新的代理对象
  const proxy = createReactive(obj);
  // 存储在map中，从而避免重复创建
  reactiveMap.set(obj, proxy);
  return proxy;
}

// 浅层响应
export function shallowReactive(obj) {
  return createReactive(obj, true);
}

// 深层只读
export function readonly(obj) {
  return createReactive(obj, false, true);
}

//浅层只读
export function shallowReadonly(obj) {
  return createReactive(obj, true, true);
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

function trigger(target, key, type, newVal) {
  // 获取target的依赖
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

  // 只有添加和删除操作才会改变对象的keys，故此时需要触发iterateEffects
  if (type === TriggerType.ADD || type === TriggerType.DELETE) {
    iterateEffects &&
      iterateEffects.forEach((effectFn) => {
        if (effectFn != activeEffect) {
          effectsToRun.add(effectFn);
        }
      });
  }

  // 如果TriggerType === ADD, 并且target是数组，说明数组的长度发生变化，则需要把数组的length也触发
  if (type === TriggerType.ADD && Array.isArray(target)) {
    const lengthEffects = depsMap.get("length");
    lengthEffects &&
      lengthEffects.forEach((effectFn) => {
        if (effectFn != activeEffect) {
          effectsToRun.add(effectFn);
        }
      });
  }

  if (Array.isArray(target) && key === "length") {
    // 对于所有索引大于或等于length值的元素
    // 需要把所有相关联的副作用函数取出并添加到effectsToRun中待执行
    depsMap.forEach((effects, key) => {
      if (typeof key !== "symbol" && key >= newVal) {
        effects.forEach((effectFn) => {
          if (effectFn !== activeEffect) {
            effectsToRun.add(effectFn);
          }
        });
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
