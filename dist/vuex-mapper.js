/**
 * vuex-mapper v1.0.0-alpha.2
 * (c) 2018 Ben Delsol <ben.t.delsol@gmail.com>
 * @license MIT
 */

(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.VuexMapper = factory());
}(this, (function () { 'use strict';

/**
 * vuexfire v3.0.0-alpha.5
 * (c) 2018 Eduardo San Martin Morote <posva13@gmail.com>
 * @license MIT
 */

function createSnapshot (doc) {
  // defaults everything to false, so no need to set
  return Object.defineProperty(doc.data(), 'id', {
    value: doc.id,
  })
}

var isObject = function (o) { return o && typeof o === 'object'; };
var isTimestamp = function (o) { return o.toDate; };
var isRef = function (o) { return o && o.onSnapshot; };

function extractRefs (doc, oldDoc, path, result) {
  if ( path === void 0 ) { path = ''; }
  if ( result === void 0 ) { result = [{}, {}]; }

  // must be set here because walkGet can return null or undefined
  oldDoc = oldDoc || {};
  var idDescriptor = Object.getOwnPropertyDescriptor(doc, 'id');
  if (idDescriptor && !idDescriptor.enumerable) {
    Object.defineProperty(result[0], 'id', idDescriptor);
  }
  return Object.keys(doc).reduce(function (tot, key) {
    var ref = doc[key];
    // if it's a ref
    if (isRef(ref)) {
      tot[0][key] = oldDoc[key] || ref.path;
      tot[1][path + key] = ref;
    } else if (Array.isArray(ref)) {
      tot[0][key] = Array(ref.length).fill(null);
      extractRefs(ref, oldDoc[key], path + key + '.', [tot[0][key], tot[1]]);
    } else if (
      ref == null ||
      // Firestore < 4.13
      ref instanceof Date ||
      isTimestamp(ref) ||
      (ref.longitude && ref.latitude) // GeoPoint
    ) {
      tot[0][key] = ref;
    } else if (isObject(ref)) {
      tot[0][key] = {};
      extractRefs(ref, oldDoc[key], path + key + '.', [tot[0][key], tot[1]]);
    } else {
      tot[0][key] = ref;
    }
    return tot
  }, result)
}

function callOnceWithArg (fn, argFn) {
  var called;
  return function () {
    if (!called) {
      called = true;
      return fn(argFn())
    }
  }
}

function walkGet (obj, path) {
  return path.split('.').reduce(function (target, key) { return target[key]; }, obj)
}

function walkSet (obj, path, value) {
  // path can be a number
  var keys = ('' + path).split('.');
  var key = keys.pop();
  var target = keys.reduce(function (target, key) { return target[key]; }, obj);
  // global isFinite is different from Number.isFinite
  // it converts values to numbers
  if (isFinite(key)) { target.splice(key, 1, value); }
  else { target[key] = value; }
}

var VUEXFIRE_SET_VALUE = 'vuexfire/SET_VALUE';
var VUEXFIRE_ARRAY_ADD = 'vuexfire/ARRAY_ADD';
var VUEXFIRE_ARRAY_REMOVE = 'vuexfire/ARRAY_REMOVE';

var obj;
var mutations = ( obj = {}, obj[VUEXFIRE_SET_VALUE] = function (state, ref) {
    var path = ref.path;
    var target = ref.target;
    var data = ref.data;

    walkSet(target, path, data);
    // state[key] = record
  }, obj[VUEXFIRE_ARRAY_ADD] = function (state, ref) {
    var newIndex = ref.newIndex;
    var data = ref.data;
    var target = ref.target;

    target.splice(newIndex, 0, data);
  }, obj[VUEXFIRE_ARRAY_REMOVE] = function (state, ref) {
    var oldIndex = ref.oldIndex;
    var target = ref.target;

    return target.splice(oldIndex, 1)[0]
  }, obj);

var firebaseMutations = {};
var commitOptions = { root: true };

Object.keys(mutations).forEach(function (type) {
  // the { commit, state, type, ...payload } syntax is not supported by buble...
  firebaseMutations[type] = function (_, context) {
    mutations[type](context.state, context);
  };
});

function unsubscribeAll (subs) {
  for (var sub in subs) {
    subs[sub].unsub();
  }
}

// NOTE not convinced by the naming of subscribeToRefs and subscribeToDocument
// first one is calling the other on every ref and subscribeToDocument may call
// updateDataFromDocumentSnapshot which may call subscribeToRefs as well
function subscribeToRefs (ref, options) {
  var subs = ref.subs;
  var refs = ref.refs;
  var target = ref.target;
  var path = ref.path;
  var data = ref.data;
  var depth = ref.depth;
  var commit = ref.commit;
  var resolve = ref.resolve;

  var refKeys = Object.keys(refs);
  var missingKeys = Object.keys(subs).filter(function (refKey) { return refKeys.indexOf(refKey) < 0; });
  // unbind keys that are no longer there
  missingKeys.forEach(function (refKey) {
    subs[refKey].unsub();
    delete subs[refKey];
  });
  if (!refKeys.length || ++depth > options.maxRefDepth) { return resolve(path) }

  var resolvedCount = 0;
  var totalToResolve = refKeys.length;
  var validResolves = Object.create(null);
  function deepResolve (key) {
    if (key in validResolves) {
      if (++resolvedCount >= totalToResolve) { resolve(path); }
    }
  }

  refKeys.forEach(function (refKey) {
    var sub = subs[refKey];
    var ref = refs[refKey];
    var docPath = path + "." + refKey;

    validResolves[docPath] = true;

    // unsubscribe if bound to a different ref
    if (sub) {
      if (sub.path !== ref.path) { sub.unsub(); }
      // if has already be bound and as we always walk the objects, it will work
      else { return }
    }

    subs[refKey] = {
      unsub: subscribeToDocument({
        ref: ref,
        target: target,
        path: docPath,
        depth: depth,
        commit: commit,
        resolve: deepResolve.bind(null, docPath),
      }, options),
      path: ref.path,
    };
  });
}

function bindCollection (ref, options) {
  var vm = ref.vm;
  var key = ref.key;
  var collection = ref.collection;
  var commit = ref.commit;
  var resolve = ref.resolve;
  var reject = ref.reject;

  commit(VUEXFIRE_SET_VALUE, {
    path: key,
    target: vm,
    data: [],
  }, commitOptions);
  var target = walkGet(vm, key);
  var originalResolve = resolve;
  var isResolved;

  // contain ref subscriptions of objects
  // arraySubs is a mirror of array
  var arraySubs = [];

  var change = {
    added: function (ref) {
      var newIndex = ref.newIndex;
      var doc = ref.doc;

      arraySubs.splice(newIndex, 0, Object.create(null));
      var subs = arraySubs[newIndex];
      var snapshot = createSnapshot(doc);
      var ref$1 = extractRefs(snapshot);
      var data = ref$1[0];
      var refs = ref$1[1];
      commit(VUEXFIRE_ARRAY_ADD, { target: target, newIndex: newIndex, data: data }, commitOptions);
      subscribeToRefs({
        data: data,
        refs: refs,
        subs: subs,
        target: target,
        path: newIndex,
        depth: 0,
        commit: commit,
        resolve: resolve.bind(null, doc),
      }, options);
    },
    modified: function (ref) {
      var oldIndex = ref.oldIndex;
      var newIndex = ref.newIndex;
      var doc = ref.doc;

      var subs = arraySubs.splice(oldIndex, 1)[0];
      arraySubs.splice(newIndex, 0, subs);
      // const oldData = array.splice(oldIndex, 1)[0]
      var oldData = commit(VUEXFIRE_ARRAY_REMOVE, { target: target, oldIndex: oldIndex }, commitOptions);
      var snapshot = createSnapshot(doc);
      var ref$1 = extractRefs(snapshot, oldData);
      var data = ref$1[0];
      var refs = ref$1[1];
      // array.splice(newIndex, 0, data)
      commit(VUEXFIRE_ARRAY_ADD, { target: target, newIndex: newIndex, data: data }, commitOptions);
      subscribeToRefs({
        data: data,
        refs: refs,
        subs: subs,
        target: target,
        path: newIndex,
        depth: 0,
        commit: commit,
        resolve: resolve,
      }, options);
    },
    removed: function (ref) {
      var oldIndex = ref.oldIndex;

      // array.splice(oldIndex, 1)
      commit(VUEXFIRE_ARRAY_REMOVE, { target: target, oldIndex: oldIndex }, commitOptions);
      unsubscribeAll(arraySubs.splice(oldIndex, 1)[0]);
    },
  };

  var unbind = collection.onSnapshot(function (ref) {
    // console.log('pending', metadata.hasPendingWrites)
    // docs.forEach(d => console.log('doc', d, '\n', 'data', d.data()))
    // NOTE this will only be triggered once and it will be with all the documents
    // from the query appearing as added
    // (https://firebase.google.com/docs/firestore/query-data/listen#view_changes_between_snapshots)
    var docChanges = typeof ref.docChanges === 'function' ? ref.docChanges() : ref.docChanges;

    if (!isResolved && docChanges.length) {
      // isResolved is only meant to make sure we do the check only once
      isResolved = true;
      var count = 0;
      var expectedItems = docChanges.length;
      var validDocs = docChanges.reduce(function (dict, ref) {
        var doc = ref.doc;

        dict[doc.id] = false;
        return dict
      }, Object.create(null));
      resolve = function (ref) {
        var id = ref.id;

        if (id in validDocs) {
          if (++count >= expectedItems) {
            originalResolve(vm[key]);
            // reset resolve to noop
            resolve = function (_) {};
          }
        }
      };
    }
    docChanges.forEach(function (c) {
      change[c.type](c);
    });

    // resolves when array is empty
    if (!docChanges.length) { resolve(); }
  }, reject);

  return function () {
    unbind();
    arraySubs.forEach(unsubscribeAll);
  }
}

function updateDataFromDocumentSnapshot (ref, options) {
  var snapshot = ref.snapshot;
  var target = ref.target;
  var path = ref.path;
  var subs = ref.subs;
  var depth = ref.depth; if ( depth === void 0 ) { depth = 0; }
  var commit = ref.commit;
  var resolve = ref.resolve;

  var ref$1 = extractRefs(snapshot, walkGet(target, path));
  var data = ref$1[0];
  var refs = ref$1[1];
  commit(VUEXFIRE_SET_VALUE, {
    path: path,
    target: target,
    data: data,
  }, commitOptions);
  subscribeToRefs({
    data: data,
    subs: subs,
    refs: refs,
    target: target,
    path: path,
    depth: depth,
    commit: commit,
    resolve: resolve,
  }, options);
}

function subscribeToDocument (ref$1, options) {
  var ref = ref$1.ref;
  var target = ref$1.target;
  var path = ref$1.path;
  var depth = ref$1.depth;
  var commit = ref$1.commit;
  var resolve = ref$1.resolve;

  var subs = Object.create(null);
  var unbind = ref.onSnapshot(function (doc) {
    if (doc.exists) {
      updateDataFromDocumentSnapshot({
        snapshot: createSnapshot(doc),
        target: target,
        path: path,
        subs: subs,
        depth: depth,
        commit: commit,
        resolve: resolve,
      }, options);
    } else {
      commit(VUEXFIRE_SET_VALUE, {
        target: target,
        path: path,
        data: null,
      }, commitOptions);
      resolve(path);
    }
  });

  return function () {
    unbind();
    unsubscribeAll(subs);
  }
}

function bindDocument (ref, options) {
  var vm = ref.vm;
  var key = ref.key;
  var document = ref.document;
  var commit = ref.commit;
  var resolve = ref.resolve;
  var reject = ref.reject;

  // TODO warning check if key exists?
  // const boundRefs = Object.create(null)

  var subs = Object.create(null);
  // bind here the function so it can be resolved anywhere
  // this is specially useful for refs
  // TODO use walkGet?
  resolve = callOnceWithArg(resolve, function () { return vm[key]; });
  var unbind = document.onSnapshot(function (doc) {
    if (doc.exists) {
      updateDataFromDocumentSnapshot({
        snapshot: createSnapshot(doc),
        target: vm,
        path: key,
        subs: subs,
        commit: commit,
        resolve: resolve,
      }, options);
    } else {
      resolve();
    }
  }, reject);

  return function () {
    unbind();
    unsubscribeAll(subs);
  }
}

// Firebase binding
var subscriptions = new WeakMap();

function bind (ref$1, options) {
  var state = ref$1.state;
  var commit = ref$1.commit;
  var key = ref$1.key;
  var ref = ref$1.ref;
  if ( options === void 0 ) { options = { maxRefDepth: 2 }; }

  // TODO check ref is valid
  // TODO check defined in state
  var sub = subscriptions.get(commit);
  if (!sub) {
    sub = Object.create(null);
    subscriptions.set(commit, sub);
  }

  // unbind if ref is already bound
  if (key in sub) {
    unbind({ commit: commit, key: key });
  }

  return new Promise(function (resolve, reject) {
    sub[key] = ref.where
      ? bindCollection({
        vm: state,
        key: key,
        collection: ref,
        commit: commit,
        resolve: resolve,
        reject: reject,
      }, options)
      : bindDocument({
        vm: state,
        key: key,
        document: ref,
        commit: commit,
        resolve: resolve,
        reject: reject,
      }, options);
  })
}

function unbind (ref) {
  var commit = ref.commit;
  var key = ref.key;

  var sub = subscriptions.get(commit);
  if (!sub) { return }
  // TODO dev check before
  sub[key]();
  delete sub[key];
}

function firebaseAction (action) {
  return function firebaseEnhancedActionFn (context, payload) {
    // get the local state and commit. These may be bound to a module
    var state = context.state;
    var commit = context.commit;
    context.bindFirebaseRef = function (key, ref, options) {
        if ( options === void 0 ) { options = {}; }

        return bind({ state: state, commit: commit, key: key, ref: ref }, options);
    };
    context.unbindFirebaseRef = function (key) { return unbind({ commit: commit, key: key }); };
    return action(context, payload)
  }
}

var commonjsGlobal = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function commonjsRequire () {
	throw new Error('Dynamic requires are not currently supported by rollup-plugin-commonjs');
}



function createCommonjsModule(fn, module) {
	return module = { exports: {} }, fn(module, module.exports), module.exports;
}

var pluralize = createCommonjsModule(function (module, exports) {
/* global define */

(function (root, pluralize) {
  /* istanbul ignore else */
  if (typeof commonjsRequire === 'function' && 'object' === 'object' && 'object' === 'object') {
    // Node.
    module.exports = pluralize();
  } else if (typeof undefined === 'function' && undefined.amd) {
    // AMD, registers as an anonymous module.
    undefined(function () {
      return pluralize();
    });
  } else {
    // Browser global.
    root.pluralize = pluralize();
  }
})(commonjsGlobal, function () {
  // Rule storage - pluralize and singularize need to be run sequentially,
  // while other rules can be optimized using an object for instant lookups.
  var pluralRules = [];
  var singularRules = [];
  var uncountables = {};
  var irregularPlurals = {};
  var irregularSingles = {};

  /**
   * Sanitize a pluralization rule to a usable regular expression.
   *
   * @param  {(RegExp|string)} rule
   * @return {RegExp}
   */
  function sanitizeRule (rule) {
    if (typeof rule === 'string') {
      return new RegExp('^' + rule + '$', 'i');
    }

    return rule;
  }

  /**
   * Pass in a word token to produce a function that can replicate the case on
   * another word.
   *
   * @param  {string}   word
   * @param  {string}   token
   * @return {Function}
   */
  function restoreCase (word, token) {
    // Tokens are an exact match.
    if (word === token) { return token; }

    // Upper cased words. E.g. "HELLO".
    if (word === word.toUpperCase()) { return token.toUpperCase(); }

    // Title cased words. E.g. "Title".
    if (word[0] === word[0].toUpperCase()) {
      return token.charAt(0).toUpperCase() + token.substr(1).toLowerCase();
    }

    // Lower cased words. E.g. "test".
    return token.toLowerCase();
  }

  /**
   * Interpolate a regexp string.
   *
   * @param  {string} str
   * @param  {Array}  args
   * @return {string}
   */
  function interpolate (str, args) {
    return str.replace(/\$(\d{1,2})/g, function (match, index) {
      return args[index] || '';
    });
  }

  /**
   * Replace a word using a rule.
   *
   * @param  {string} word
   * @param  {Array}  rule
   * @return {string}
   */
  function replace (word, rule) {
    return word.replace(rule[0], function (match, index) {
      var result = interpolate(rule[1], arguments);

      if (match === '') {
        return restoreCase(word[index - 1], result);
      }

      return restoreCase(match, result);
    });
  }

  /**
   * Sanitize a word by passing in the word and sanitization rules.
   *
   * @param  {string}   token
   * @param  {string}   word
   * @param  {Array}    rules
   * @return {string}
   */
  function sanitizeWord (token, word, rules) {
    // Empty string or doesn't need fixing.
    if (!token.length || uncountables.hasOwnProperty(token)) {
      return word;
    }

    var len = rules.length;

    // Iterate over the sanitization rules and use the first one to match.
    while (len--) {
      var rule = rules[len];

      if (rule[0].test(word)) { return replace(word, rule); }
    }

    return word;
  }

  /**
   * Replace a word with the updated word.
   *
   * @param  {Object}   replaceMap
   * @param  {Object}   keepMap
   * @param  {Array}    rules
   * @return {Function}
   */
  function replaceWord (replaceMap, keepMap, rules) {
    return function (word) {
      // Get the correct token and case restoration functions.
      var token = word.toLowerCase();

      // Check against the keep object map.
      if (keepMap.hasOwnProperty(token)) {
        return restoreCase(word, token);
      }

      // Check against the replacement map for a direct word replacement.
      if (replaceMap.hasOwnProperty(token)) {
        return restoreCase(word, replaceMap[token]);
      }

      // Run all the rules against the word.
      return sanitizeWord(token, word, rules);
    };
  }

  /**
   * Check if a word is part of the map.
   */
  function checkWord (replaceMap, keepMap, rules, bool) {
    return function (word) {
      var token = word.toLowerCase();

      if (keepMap.hasOwnProperty(token)) { return true; }
      if (replaceMap.hasOwnProperty(token)) { return false; }

      return sanitizeWord(token, token, rules) === token;
    };
  }

  /**
   * Pluralize or singularize a word based on the passed in count.
   *
   * @param  {string}  word
   * @param  {number}  count
   * @param  {boolean} inclusive
   * @return {string}
   */
  function pluralize (word, count, inclusive) {
    var pluralized = count === 1
      ? pluralize.singular(word) : pluralize.plural(word);

    return (inclusive ? count + ' ' : '') + pluralized;
  }

  /**
   * Pluralize a word.
   *
   * @type {Function}
   */
  pluralize.plural = replaceWord(
    irregularSingles, irregularPlurals, pluralRules
  );

  /**
   * Check if a word is plural.
   *
   * @type {Function}
   */
  pluralize.isPlural = checkWord(
    irregularSingles, irregularPlurals, pluralRules
  );

  /**
   * Singularize a word.
   *
   * @type {Function}
   */
  pluralize.singular = replaceWord(
    irregularPlurals, irregularSingles, singularRules
  );

  /**
   * Check if a word is singular.
   *
   * @type {Function}
   */
  pluralize.isSingular = checkWord(
    irregularPlurals, irregularSingles, singularRules
  );

  /**
   * Add a pluralization rule to the collection.
   *
   * @param {(string|RegExp)} rule
   * @param {string}          replacement
   */
  pluralize.addPluralRule = function (rule, replacement) {
    pluralRules.push([sanitizeRule(rule), replacement]);
  };

  /**
   * Add a singularization rule to the collection.
   *
   * @param {(string|RegExp)} rule
   * @param {string}          replacement
   */
  pluralize.addSingularRule = function (rule, replacement) {
    singularRules.push([sanitizeRule(rule), replacement]);
  };

  /**
   * Add an uncountable word rule.
   *
   * @param {(string|RegExp)} word
   */
  pluralize.addUncountableRule = function (word) {
    if (typeof word === 'string') {
      uncountables[word.toLowerCase()] = true;
      return;
    }

    // Set singular and plural references for the word.
    pluralize.addPluralRule(word, '$0');
    pluralize.addSingularRule(word, '$0');
  };

  /**
   * Add an irregular word definition.
   *
   * @param {string} single
   * @param {string} plural
   */
  pluralize.addIrregularRule = function (single, plural) {
    plural = plural.toLowerCase();
    single = single.toLowerCase();

    irregularSingles[single] = plural;
    irregularPlurals[plural] = single;
  };

  /**
   * Irregular rules.
   */
  [
    // Pronouns.
    ['I', 'we'],
    ['me', 'us'],
    ['he', 'they'],
    ['she', 'they'],
    ['them', 'them'],
    ['myself', 'ourselves'],
    ['yourself', 'yourselves'],
    ['itself', 'themselves'],
    ['herself', 'themselves'],
    ['himself', 'themselves'],
    ['themself', 'themselves'],
    ['is', 'are'],
    ['was', 'were'],
    ['has', 'have'],
    ['this', 'these'],
    ['that', 'those'],
    // Words ending in with a consonant and `o`.
    ['echo', 'echoes'],
    ['dingo', 'dingoes'],
    ['volcano', 'volcanoes'],
    ['tornado', 'tornadoes'],
    ['torpedo', 'torpedoes'],
    // Ends with `us`.
    ['genus', 'genera'],
    ['viscus', 'viscera'],
    // Ends with `ma`.
    ['stigma', 'stigmata'],
    ['stoma', 'stomata'],
    ['dogma', 'dogmata'],
    ['lemma', 'lemmata'],
    ['schema', 'schemata'],
    ['anathema', 'anathemata'],
    // Other irregular rules.
    ['ox', 'oxen'],
    ['axe', 'axes'],
    ['die', 'dice'],
    ['yes', 'yeses'],
    ['foot', 'feet'],
    ['eave', 'eaves'],
    ['goose', 'geese'],
    ['tooth', 'teeth'],
    ['quiz', 'quizzes'],
    ['human', 'humans'],
    ['proof', 'proofs'],
    ['carve', 'carves'],
    ['valve', 'valves'],
    ['looey', 'looies'],
    ['thief', 'thieves'],
    ['groove', 'grooves'],
    ['pickaxe', 'pickaxes'],
    ['whiskey', 'whiskies']
  ].forEach(function (rule) {
    return pluralize.addIrregularRule(rule[0], rule[1]);
  });

  /**
   * Pluralization rules.
   */
  [
    [/s?$/i, 's'],
    [/[^\u0000-\u007F]$/i, '$0'],
    [/([^aeiou]ese)$/i, '$1'],
    [/(ax|test)is$/i, '$1es'],
    [/(alias|[^aou]us|tlas|gas|ris)$/i, '$1es'],
    [/(e[mn]u)s?$/i, '$1s'],
    [/([^l]ias|[aeiou]las|[emjzr]as|[iu]am)$/i, '$1'],
    [/(alumn|syllab|octop|vir|radi|nucle|fung|cact|stimul|termin|bacill|foc|uter|loc|strat)(?:us|i)$/i, '$1i'],
    [/(alumn|alg|vertebr)(?:a|ae)$/i, '$1ae'],
    [/(seraph|cherub)(?:im)?$/i, '$1im'],
    [/(her|at|gr)o$/i, '$1oes'],
    [/(agend|addend|millenni|dat|extrem|bacteri|desiderat|strat|candelabr|errat|ov|symposi|curricul|automat|quor)(?:a|um)$/i, '$1a'],
    [/(apheli|hyperbat|periheli|asyndet|noumen|phenomen|criteri|organ|prolegomen|hedr|automat)(?:a|on)$/i, '$1a'],
    [/sis$/i, 'ses'],
    [/(?:(kni|wi|li)fe|(ar|l|ea|eo|oa|hoo)f)$/i, '$1$2ves'],
    [/([^aeiouy]|qu)y$/i, '$1ies'],
    [/([^ch][ieo][ln])ey$/i, '$1ies'],
    [/(x|ch|ss|sh|zz)$/i, '$1es'],
    [/(matr|cod|mur|sil|vert|ind|append)(?:ix|ex)$/i, '$1ices'],
    [/(m|l)(?:ice|ouse)$/i, '$1ice'],
    [/(pe)(?:rson|ople)$/i, '$1ople'],
    [/(child)(?:ren)?$/i, '$1ren'],
    [/eaux$/i, '$0'],
    [/m[ae]n$/i, 'men'],
    ['thou', 'you']
  ].forEach(function (rule) {
    return pluralize.addPluralRule(rule[0], rule[1]);
  });

  /**
   * Singularization rules.
   */
  [
    [/s$/i, ''],
    [/(ss)$/i, '$1'],
    [/(wi|kni|(?:after|half|high|low|mid|non|night|[^\w]|^)li)ves$/i, '$1fe'],
    [/(ar|(?:wo|[ae])l|[eo][ao])ves$/i, '$1f'],
    [/ies$/i, 'y'],
    [/\b([pl]|zomb|(?:neck|cross)?t|coll|faer|food|gen|goon|group|lass|talk|goal|cut)ies$/i, '$1ie'],
    [/\b(mon|smil)ies$/i, '$1ey'],
    [/(m|l)ice$/i, '$1ouse'],
    [/(seraph|cherub)im$/i, '$1'],
    [/(x|ch|ss|sh|zz|tto|go|cho|alias|[^aou]us|tlas|gas|(?:her|at|gr)o|ris)(?:es)?$/i, '$1'],
    [/(analy|ba|diagno|parenthe|progno|synop|the|empha|cri)(?:sis|ses)$/i, '$1sis'],
    [/(movie|twelve|abuse|e[mn]u)s$/i, '$1'],
    [/(test)(?:is|es)$/i, '$1is'],
    [/(alumn|syllab|octop|vir|radi|nucle|fung|cact|stimul|termin|bacill|foc|uter|loc|strat)(?:us|i)$/i, '$1us'],
    [/(agend|addend|millenni|dat|extrem|bacteri|desiderat|strat|candelabr|errat|ov|symposi|curricul|quor)a$/i, '$1um'],
    [/(apheli|hyperbat|periheli|asyndet|noumen|phenomen|criteri|organ|prolegomen|hedr|automat)a$/i, '$1on'],
    [/(alumn|alg|vertebr)ae$/i, '$1a'],
    [/(cod|mur|sil|vert|ind)ices$/i, '$1ex'],
    [/(matr|append)ices$/i, '$1ix'],
    [/(pe)(rson|ople)$/i, '$1rson'],
    [/(child)ren$/i, '$1'],
    [/(eau)x?$/i, '$1'],
    [/men$/i, 'man']
  ].forEach(function (rule) {
    return pluralize.addSingularRule(rule[0], rule[1]);
  });

  /**
   * Uncountable rules.
   */
  [
    // Singular words with no plurals.
    'adulthood',
    'advice',
    'agenda',
    'aid',
    'alcohol',
    'ammo',
    'anime',
    'athletics',
    'audio',
    'bison',
    'blood',
    'bream',
    'buffalo',
    'butter',
    'carp',
    'cash',
    'chassis',
    'chess',
    'clothing',
    'cod',
    'commerce',
    'cooperation',
    'corps',
    'debris',
    'diabetes',
    'digestion',
    'elk',
    'energy',
    'equipment',
    'excretion',
    'expertise',
    'flounder',
    'fun',
    'gallows',
    'garbage',
    'graffiti',
    'headquarters',
    'health',
    'herpes',
    'highjinks',
    'homework',
    'housework',
    'information',
    'jeans',
    'justice',
    'kudos',
    'labour',
    'literature',
    'machinery',
    'mackerel',
    'mail',
    'media',
    'mews',
    'moose',
    'music',
    'manga',
    'news',
    'pike',
    'plankton',
    'pliers',
    'pollution',
    'premises',
    'rain',
    'research',
    'rice',
    'salmon',
    'scissors',
    'series',
    'sewage',
    'shambles',
    'shrimp',
    'species',
    'staff',
    'swine',
    'tennis',
    'traffic',
    'transporation',
    'trout',
    'tuna',
    'wealth',
    'welfare',
    'whiting',
    'wildebeest',
    'wildlife',
    'you',
    // Regexes.
    /[^aeiou]ese$/i, // "chinese", "japanese"
    /deer$/i, // "deer", "reindeer"
    /fish$/i, // "fish", "blowfish", "angelfish"
    /measles$/i,
    /o[iu]s$/i, // "carnivorous"
    /pox$/i, // "chickpox", "smallpox"
    /sheep$/i
  ].forEach(pluralize.addUncountableRule);

  return pluralize;
});
});

var preserveCamelCase = function (input) {
	var isLastCharLower = false;
	var isLastCharUpper = false;
	var isLastLastCharUpper = false;

	for (var i = 0; i < input.length; i++) {
		var c = input[i];

		if (isLastCharLower && /[a-zA-Z]/.test(c) && c.toUpperCase() === c) {
			input = input.slice(0, i) + '-' + input.slice(i);
			isLastCharLower = false;
			isLastLastCharUpper = isLastCharUpper;
			isLastCharUpper = true;
			i++;
		} else if (isLastCharUpper && isLastLastCharUpper && /[a-zA-Z]/.test(c) && c.toLowerCase() === c) {
			input = input.slice(0, i - 1) + '-' + input.slice(i - 1);
			isLastLastCharUpper = isLastCharUpper;
			isLastCharUpper = false;
			isLastCharLower = true;
		} else {
			isLastCharLower = c.toLowerCase() === c;
			isLastLastCharUpper = isLastCharUpper;
			isLastCharUpper = c.toUpperCase() === c;
		}
	}

	return input;
};

var camelcase = function (input, options) {
	options = Object.assign({
		pascalCase: false
	}, options);

	var postProcess = function (x) { return options.pascalCase ? x.charAt(0).toUpperCase() + x.slice(1) : x; };

	if (Array.isArray(input)) {
		input = input.map(function (x) { return x.trim(); })
			.filter(function (x) { return x.length; })
			.join('-');
	} else {
		input = input.trim();
	}

	if (input.length === 0) {
		return '';
	}

	if (input.length === 1) {
		return options.pascalCase ? input.toUpperCase() : input.toLowerCase();
	}

	if (/^[a-z\d]+$/.test(input)) {
		return postProcess(input);
	}

	var hasUpperCase = input !== input.toLowerCase();

	if (hasUpperCase) {
		input = preserveCamelCase(input);
	}

	input = input
		.replace(/^[_.\- ]+/, '')
		.toLowerCase()
		.replace(/[_.\- ]+(\w|$)/g, function (m, p1) { return p1.toUpperCase(); });

	return postProcess(input);
};

/**
 * lodash (Custom Build) <https://lodash.com/>
 * Build: `lodash modularize exports="npm" -o ./`
 * Copyright jQuery Foundation and other contributors <https://jquery.org/>
 * Released under MIT license <https://lodash.com/license>
 * Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
 * Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
 */

/** Used as references for various `Number` constants. */
var INFINITY = 1 / 0;

/** `Object#toString` result references. */
var symbolTag = '[object Symbol]';

/** Used to match words composed of alphanumeric characters. */
var reAsciiWord = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g;

/** Used to match Latin Unicode letters (excluding mathematical operators). */
var reLatin = /[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g;

/** Used to compose unicode character classes. */
var rsAstralRange = '\\ud800-\\udfff';
var rsComboMarksRange = '\\u0300-\\u036f\\ufe20-\\ufe23';
var rsComboSymbolsRange = '\\u20d0-\\u20f0';
var rsDingbatRange = '\\u2700-\\u27bf';
var rsLowerRange = 'a-z\\xdf-\\xf6\\xf8-\\xff';
var rsMathOpRange = '\\xac\\xb1\\xd7\\xf7';
var rsNonCharRange = '\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf';
var rsPunctuationRange = '\\u2000-\\u206f';
var rsSpaceRange = ' \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000';
var rsUpperRange = 'A-Z\\xc0-\\xd6\\xd8-\\xde';
var rsVarRange = '\\ufe0e\\ufe0f';
var rsBreakRange = rsMathOpRange + rsNonCharRange + rsPunctuationRange + rsSpaceRange;

/** Used to compose unicode capture groups. */
var rsApos = "['\u2019]";
var rsBreak = '[' + rsBreakRange + ']';
var rsCombo = '[' + rsComboMarksRange + rsComboSymbolsRange + ']';
var rsDigits = '\\d+';
var rsDingbat = '[' + rsDingbatRange + ']';
var rsLower = '[' + rsLowerRange + ']';
var rsMisc = '[^' + rsAstralRange + rsBreakRange + rsDigits + rsDingbatRange + rsLowerRange + rsUpperRange + ']';
var rsFitz = '\\ud83c[\\udffb-\\udfff]';
var rsModifier = '(?:' + rsCombo + '|' + rsFitz + ')';
var rsNonAstral = '[^' + rsAstralRange + ']';
var rsRegional = '(?:\\ud83c[\\udde6-\\uddff]){2}';
var rsSurrPair = '[\\ud800-\\udbff][\\udc00-\\udfff]';
var rsUpper = '[' + rsUpperRange + ']';
var rsZWJ = '\\u200d';

/** Used to compose unicode regexes. */
var rsLowerMisc = '(?:' + rsLower + '|' + rsMisc + ')';
var rsUpperMisc = '(?:' + rsUpper + '|' + rsMisc + ')';
var rsOptLowerContr = '(?:' + rsApos + '(?:d|ll|m|re|s|t|ve))?';
var rsOptUpperContr = '(?:' + rsApos + '(?:D|LL|M|RE|S|T|VE))?';
var reOptMod = rsModifier + '?';
var rsOptVar = '[' + rsVarRange + ']?';
var rsOptJoin = '(?:' + rsZWJ + '(?:' + [rsNonAstral, rsRegional, rsSurrPair].join('|') + ')' + rsOptVar + reOptMod + ')*';
var rsSeq = rsOptVar + reOptMod + rsOptJoin;
var rsEmoji = '(?:' + [rsDingbat, rsRegional, rsSurrPair].join('|') + ')' + rsSeq;

/** Used to match apostrophes. */
var reApos = RegExp(rsApos, 'g');

/**
 * Used to match [combining diacritical marks](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks) and
 * [combining diacritical marks for symbols](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks_for_Symbols).
 */
var reComboMark = RegExp(rsCombo, 'g');

/** Used to match complex or compound words. */
var reUnicodeWord = RegExp([
  rsUpper + '?' + rsLower + '+' + rsOptLowerContr + '(?=' + [rsBreak, rsUpper, '$'].join('|') + ')',
  rsUpperMisc + '+' + rsOptUpperContr + '(?=' + [rsBreak, rsUpper + rsLowerMisc, '$'].join('|') + ')',
  rsUpper + '?' + rsLowerMisc + '+' + rsOptLowerContr,
  rsUpper + '+' + rsOptUpperContr,
  rsDigits,
  rsEmoji
].join('|'), 'g');

/** Used to detect strings that need a more robust regexp to match words. */
var reHasUnicodeWord = /[a-z][A-Z]|[A-Z]{2,}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/;

/** Used to map Latin Unicode letters to basic Latin letters. */
var deburredLetters = {
  // Latin-1 Supplement block.
  '\xc0': 'A',  '\xc1': 'A', '\xc2': 'A', '\xc3': 'A', '\xc4': 'A', '\xc5': 'A',
  '\xe0': 'a',  '\xe1': 'a', '\xe2': 'a', '\xe3': 'a', '\xe4': 'a', '\xe5': 'a',
  '\xc7': 'C',  '\xe7': 'c',
  '\xd0': 'D',  '\xf0': 'd',
  '\xc8': 'E',  '\xc9': 'E', '\xca': 'E', '\xcb': 'E',
  '\xe8': 'e',  '\xe9': 'e', '\xea': 'e', '\xeb': 'e',
  '\xcc': 'I',  '\xcd': 'I', '\xce': 'I', '\xcf': 'I',
  '\xec': 'i',  '\xed': 'i', '\xee': 'i', '\xef': 'i',
  '\xd1': 'N',  '\xf1': 'n',
  '\xd2': 'O',  '\xd3': 'O', '\xd4': 'O', '\xd5': 'O', '\xd6': 'O', '\xd8': 'O',
  '\xf2': 'o',  '\xf3': 'o', '\xf4': 'o', '\xf5': 'o', '\xf6': 'o', '\xf8': 'o',
  '\xd9': 'U',  '\xda': 'U', '\xdb': 'U', '\xdc': 'U',
  '\xf9': 'u',  '\xfa': 'u', '\xfb': 'u', '\xfc': 'u',
  '\xdd': 'Y',  '\xfd': 'y', '\xff': 'y',
  '\xc6': 'Ae', '\xe6': 'ae',
  '\xde': 'Th', '\xfe': 'th',
  '\xdf': 'ss',
  // Latin Extended-A block.
  '\u0100': 'A',  '\u0102': 'A', '\u0104': 'A',
  '\u0101': 'a',  '\u0103': 'a', '\u0105': 'a',
  '\u0106': 'C',  '\u0108': 'C', '\u010a': 'C', '\u010c': 'C',
  '\u0107': 'c',  '\u0109': 'c', '\u010b': 'c', '\u010d': 'c',
  '\u010e': 'D',  '\u0110': 'D', '\u010f': 'd', '\u0111': 'd',
  '\u0112': 'E',  '\u0114': 'E', '\u0116': 'E', '\u0118': 'E', '\u011a': 'E',
  '\u0113': 'e',  '\u0115': 'e', '\u0117': 'e', '\u0119': 'e', '\u011b': 'e',
  '\u011c': 'G',  '\u011e': 'G', '\u0120': 'G', '\u0122': 'G',
  '\u011d': 'g',  '\u011f': 'g', '\u0121': 'g', '\u0123': 'g',
  '\u0124': 'H',  '\u0126': 'H', '\u0125': 'h', '\u0127': 'h',
  '\u0128': 'I',  '\u012a': 'I', '\u012c': 'I', '\u012e': 'I', '\u0130': 'I',
  '\u0129': 'i',  '\u012b': 'i', '\u012d': 'i', '\u012f': 'i', '\u0131': 'i',
  '\u0134': 'J',  '\u0135': 'j',
  '\u0136': 'K',  '\u0137': 'k', '\u0138': 'k',
  '\u0139': 'L',  '\u013b': 'L', '\u013d': 'L', '\u013f': 'L', '\u0141': 'L',
  '\u013a': 'l',  '\u013c': 'l', '\u013e': 'l', '\u0140': 'l', '\u0142': 'l',
  '\u0143': 'N',  '\u0145': 'N', '\u0147': 'N', '\u014a': 'N',
  '\u0144': 'n',  '\u0146': 'n', '\u0148': 'n', '\u014b': 'n',
  '\u014c': 'O',  '\u014e': 'O', '\u0150': 'O',
  '\u014d': 'o',  '\u014f': 'o', '\u0151': 'o',
  '\u0154': 'R',  '\u0156': 'R', '\u0158': 'R',
  '\u0155': 'r',  '\u0157': 'r', '\u0159': 'r',
  '\u015a': 'S',  '\u015c': 'S', '\u015e': 'S', '\u0160': 'S',
  '\u015b': 's',  '\u015d': 's', '\u015f': 's', '\u0161': 's',
  '\u0162': 'T',  '\u0164': 'T', '\u0166': 'T',
  '\u0163': 't',  '\u0165': 't', '\u0167': 't',
  '\u0168': 'U',  '\u016a': 'U', '\u016c': 'U', '\u016e': 'U', '\u0170': 'U', '\u0172': 'U',
  '\u0169': 'u',  '\u016b': 'u', '\u016d': 'u', '\u016f': 'u', '\u0171': 'u', '\u0173': 'u',
  '\u0174': 'W',  '\u0175': 'w',
  '\u0176': 'Y',  '\u0177': 'y', '\u0178': 'Y',
  '\u0179': 'Z',  '\u017b': 'Z', '\u017d': 'Z',
  '\u017a': 'z',  '\u017c': 'z', '\u017e': 'z',
  '\u0132': 'IJ', '\u0133': 'ij',
  '\u0152': 'Oe', '\u0153': 'oe',
  '\u0149': "'n", '\u017f': 'ss'
};

/** Detect free variable `global` from Node.js. */
var freeGlobal = typeof commonjsGlobal == 'object' && commonjsGlobal && commonjsGlobal.Object === Object && commonjsGlobal;

/** Detect free variable `self`. */
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

/** Used as a reference to the global object. */
var root = freeGlobal || freeSelf || Function('return this')();

/**
 * A specialized version of `_.reduce` for arrays without support for
 * iteratee shorthands.
 *
 * @private
 * @param {Array} [array] The array to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @param {*} [accumulator] The initial value.
 * @param {boolean} [initAccum] Specify using the first element of `array` as
 *  the initial value.
 * @returns {*} Returns the accumulated value.
 */
function arrayReduce(array, iteratee, accumulator, initAccum) {
  var index = -1,
      length = array ? array.length : 0;

  if (initAccum && length) {
    accumulator = array[++index];
  }
  while (++index < length) {
    accumulator = iteratee(accumulator, array[index], index, array);
  }
  return accumulator;
}

/**
 * Splits an ASCII `string` into an array of its words.
 *
 * @private
 * @param {string} The string to inspect.
 * @returns {Array} Returns the words of `string`.
 */
function asciiWords(string) {
  return string.match(reAsciiWord) || [];
}

/**
 * The base implementation of `_.propertyOf` without support for deep paths.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Function} Returns the new accessor function.
 */
function basePropertyOf(object) {
  return function(key) {
    return object == null ? undefined : object[key];
  };
}

/**
 * Used by `_.deburr` to convert Latin-1 Supplement and Latin Extended-A
 * letters to basic Latin letters.
 *
 * @private
 * @param {string} letter The matched letter to deburr.
 * @returns {string} Returns the deburred letter.
 */
var deburrLetter = basePropertyOf(deburredLetters);

/**
 * Checks if `string` contains a word composed of Unicode symbols.
 *
 * @private
 * @param {string} string The string to inspect.
 * @returns {boolean} Returns `true` if a word is found, else `false`.
 */
function hasUnicodeWord(string) {
  return reHasUnicodeWord.test(string);
}

/**
 * Splits a Unicode `string` into an array of its words.
 *
 * @private
 * @param {string} The string to inspect.
 * @returns {Array} Returns the words of `string`.
 */
function unicodeWords(string) {
  return string.match(reUnicodeWord) || [];
}

/** Used for built-in method references. */
var objectProto = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/** Built-in value references. */
var Symbol = root.Symbol;

/** Used to convert symbols to primitives and strings. */
var symbolProto = Symbol ? Symbol.prototype : undefined;
var symbolToString = symbolProto ? symbolProto.toString : undefined;

/**
 * The base implementation of `_.toString` which doesn't convert nullish
 * values to empty strings.
 *
 * @private
 * @param {*} value The value to process.
 * @returns {string} Returns the string.
 */
function baseToString(value) {
  // Exit early for strings to avoid a performance hit in some environments.
  if (typeof value == 'string') {
    return value;
  }
  if (isSymbol(value)) {
    return symbolToString ? symbolToString.call(value) : '';
  }
  var result = (value + '');
  return (result == '0' && (1 / value) == -INFINITY) ? '-0' : result;
}

/**
 * Creates a function like `_.camelCase`.
 *
 * @private
 * @param {Function} callback The function to combine each word.
 * @returns {Function} Returns the new compounder function.
 */
function createCompounder(callback) {
  return function(string) {
    return arrayReduce(words(deburr(string).replace(reApos, '')), callback, '');
  };
}

/**
 * Checks if `value` is object-like. A value is object-like if it's not `null`
 * and has a `typeof` result of "object".
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
 * @example
 *
 * _.isObjectLike({});
 * // => true
 *
 * _.isObjectLike([1, 2, 3]);
 * // => true
 *
 * _.isObjectLike(_.noop);
 * // => false
 *
 * _.isObjectLike(null);
 * // => false
 */
function isObjectLike(value) {
  return !!value && typeof value == 'object';
}

/**
 * Checks if `value` is classified as a `Symbol` primitive or object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
 * @example
 *
 * _.isSymbol(Symbol.iterator);
 * // => true
 *
 * _.isSymbol('abc');
 * // => false
 */
function isSymbol(value) {
  return typeof value == 'symbol' ||
    (isObjectLike(value) && objectToString.call(value) == symbolTag);
}

/**
 * Converts `value` to a string. An empty string is returned for `null`
 * and `undefined` values. The sign of `-0` is preserved.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to process.
 * @returns {string} Returns the string.
 * @example
 *
 * _.toString(null);
 * // => ''
 *
 * _.toString(-0);
 * // => '-0'
 *
 * _.toString([1, 2, 3]);
 * // => '1,2,3'
 */
function toString(value) {
  return value == null ? '' : baseToString(value);
}

/**
 * Deburrs `string` by converting
 * [Latin-1 Supplement](https://en.wikipedia.org/wiki/Latin-1_Supplement_(Unicode_block)#Character_table)
 * and [Latin Extended-A](https://en.wikipedia.org/wiki/Latin_Extended-A)
 * letters to basic Latin letters and removing
 * [combining diacritical marks](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks).
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category String
 * @param {string} [string=''] The string to deburr.
 * @returns {string} Returns the deburred string.
 * @example
 *
 * _.deburr('déjà vu');
 * // => 'deja vu'
 */
function deburr(string) {
  string = toString(string);
  return string && string.replace(reLatin, deburrLetter).replace(reComboMark, '');
}

/**
 * Converts `string` to
 * [kebab case](https://en.wikipedia.org/wiki/Letter_case#Special_case_styles).
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category String
 * @param {string} [string=''] The string to convert.
 * @returns {string} Returns the kebab cased string.
 * @example
 *
 * _.kebabCase('Foo Bar');
 * // => 'foo-bar'
 *
 * _.kebabCase('fooBar');
 * // => 'foo-bar'
 *
 * _.kebabCase('__FOO_BAR__');
 * // => 'foo-bar'
 */
var kebabCase = createCompounder(function(result, word, index) {
  return result + (index ? '-' : '') + word.toLowerCase();
});

/**
 * Splits `string` into an array of its words.
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category String
 * @param {string} [string=''] The string to inspect.
 * @param {RegExp|string} [pattern] The pattern to match words.
 * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
 * @returns {Array} Returns the words of `string`.
 * @example
 *
 * _.words('fred, barney, & pebbles');
 * // => ['fred', 'barney', 'pebbles']
 *
 * _.words('fred, barney, & pebbles', /[^, ]+/g);
 * // => ['fred', 'barney', '&', 'pebbles']
 */
function words(string, pattern, guard) {
  string = toString(string);
  pattern = guard ? undefined : pattern;

  if (pattern === undefined) {
    return hasUnicodeWord(string) ? unicodeWords(string) : asciiWords(string);
  }
  return string.match(pattern) || [];
}

var lodash_kebabcase = kebabCase;

// BEGIN vuexmodule stuff
// import debounce from 'lodash.debounce';

// BEGIN documentMapper and documentClassMethods stuff
// BEGIN vuexmodule stuff
var refs = {};

// TODO in the future if this needs to be customized per model, it can be passed
// in via setRef().
var queryFn = function(ref, context) {
  return ref
    .where("authorId", "==", context.rootState.user.uid)
    .orderBy("createdAt", "asc");
};

// BEGIN documentMapper and documentClassMethods stuff
// Mongoid
// -------
// embedsOne and embeddedIn store object in the document
// embedsMany and embeddedIn store objects in an array in the document
// hasOne (parent doc) and belongsTo (child doc, has reference to parent doc)
// hasMany one-to-many (parent doc) and belongsTo (child doc, has reference to parent doc)
//   has* support the category.todos.create()
// belongsTo stores parent refId
// hasAndBelongsToMany / many-to-many (stores ids in an array in the document
//
// create
// create!
// new
// save
// save!
// updateAttributes({}) / updateAttribute
// updateAttributes!({})
// upsert (aka findAndUpdateOrCreate)
// delete // wo running callbacks
// destroy // run destroy callbacks
// Category.deleteAll
// Category.destroyAll
//
// documentMixin
// -------------
// fields:
//   Array of strings which map vuex state to vue instance computed property.
//   Example: todo.text
//
// embedsOne:
//   Not supported yet. I'll implement embedsOne if a case arises for an object needing absolute ownership and stored in the document. This will save a query. Otherwise I'll implement hasOne so the object can belong to other documents as well.
//
// embedsMany (subcollection):
//   Unlike Mongoid, embedsMany is not supported in-document. Instead its stored as a subcollection. In the future I could support embedsMany in-doc with an option to embedsMany.
//   Example: todo.subTasks
//
// embeddedIn (parent):
//   Used for documents of a subcollection to create a computed property to the parent document which the subcollection is contained in. Potentially for embedsOne as well if ever implemented.
//   Example: subTask.todo
//
// belongsTo (references):
//   Creates a computed property to a document in a root collection. The reference is stored in this document.
//   Example: agentInstance.agent
//
// hasOne:
//   Not supported yet. If implemented, it would do query on other collection for its id.
//
// hasMany:
//   Not supported yet. Used for a one-to-many by querying another collection for multiple documents with its id. In contrast to embedsMany, hasMany would not create exclusive ownership of the documents. 
//
// hasAndBelongsToMany (collections):
//   Currently implemented with join. TODO Need to implement as arrays of ids in documents of each collection like Mongoid does to save a query and complexity.

// TODO bring these into VuexMapper as instance variables
var modules = {};
var registeredDynamicModules = {};

var VuexMapper = function VuexMapper(requireModule, ref) {
  var currentTime = ref.currentTime;

  this.requireModule = requireModule;
  this.currentTime = currentTime;
};

VuexMapper.prototype.lookupModel = function lookupModel (collectionName) {
  var modelName = pluralize.singular(collectionName);
  var fileName = "./" + (lodash_kebabcase(modelName));
  return this.requireModule(fileName).default;
};

VuexMapper.prototype.vuexModule = function vuexModule (ref) {
    var name = ref.name;
    var joinsWith = ref.joinsWith;


  // subTasks
  var collectionName = name;
  var joinCollectionNames = (joinsWith || []).map(function (otherName) {
    return [collectionName, otherName].sort().join("_");
  });
  var currentTime = this.currentTime;

  var submodule = {
    namespaced: true,
    modules: {
    },

    state: function () {
      var s = {
        refKey: ""
      };
      s[collectionName] = [];
      return s;
    },

    getters: {
    },

    mutations: {

      setRef: function setRef (state, ref$1) {
          var ref = ref$1.ref;
          var parentDocId = ref$1.parentDocId;

        if (parentDocId) {
          state.refKey = collectionName + "-" + parentDocId;
        } else {
          state.refKey = collectionName;
        }
        refs[state.refKey] = ref;
      }

    },

    actions: {

      setRef: firebaseAction(function (context, ref$1) {
          var ref = ref$1.ref;
          var parentDocId = ref$1.parentDocId;

        if (refs[context.state.refKey] && ref.isEqual(refs[context.state.refKey])) {
          return Promise.resolve();
        }
        context.commit("setRef", {ref: ref, parentDocId: parentDocId});
        var sortedRef = queryFn(refs[context.state.refKey], context);
        return context.bindFirebaseRef(collectionName, sortedRef);
      }),

      unsetRef: firebaseAction(function (ref) {
          var state = ref.state;
          var unbindFirebaseRef = ref.unbindFirebaseRef;

        unbindFirebaseRef(collectionName);
        delete refs[state.refKey];
      }),

      // TODO Part of old HABTM join implementation. Remove once implementation changes.
      addWithId: function(ref, payload) {
          var state = ref.state;
          var rootState = ref.rootState;
          var dispatch = ref.dispatch;
          if ( payload === void 0 ) payload={};

        var docRef = refs[state.refKey].doc(payload.id);
        delete payload.id;
        return dispatch(
          "saveTransaction",
          docRef.set(Object.assign({}, payload,
            {authorId: rootState.user.uid,
            createdAt: currentTime()})),
          { root: true }
        );
      },

      add: function(ref, payload) {
          var state = ref.state;
          var rootState = ref.rootState;
          var dispatch = ref.dispatch;
          if ( payload === void 0 ) payload={};

        return dispatch(
          "saveTransaction",
          refs[state.refKey].add(Object.assign({}, payload,
            {authorId: rootState.user.uid,
            createdAt: currentTime()})),
          { root: true }
        );
      },

      update: function (ref, payload) {
          var state = ref.state;
          var dispatch = ref.dispatch;

        // TODO debounce, at least for tests, maybe for web, not for json
        // tough to do unless update() is passed the entire payload.
        // Probably need to do that anyways to make make-module generic
        // but then we're trading small/frequent updates for large/
        // infrequent updates.
        var id = payload.id;
        var attributes = Object.assign({}, payload);
        delete attributes.id;
        return dispatch(
          "saveTransaction",
          refs[state.refKey].doc(id).update(attributes),
          { root: true }
        );
      },

      get: function(context) {
        return queryFn(refs[context.state.refKey], context)
          .get()
          .then(function (snapshot) {
            // Remove all the child docs
            return snapshot.docs.map(function (doc) {
              return refs[context.state.refKey].doc(doc.ref.id);
            });
          });
      },

      remove: function(ref, id) {
          var state = ref.state;
          var rootState = ref.rootState;
          var dispatch = ref.dispatch;

        var p0 = refs[state.refKey].doc(id).delete();
        // TODO remove p1 once HABTM is removed/reimplemented w/o join collection.
        var p1 = joinCollectionNames.map(function (j) {
          // MOOT not sure if rootState is guaranteed to have join sync'd.
          var p2 = rootState[j][j]
            .filter(function (state) {
              return (state[(collectionName + "Id")] === id);
            })
            .map(function (state) {
              return refs[j].doc(state.id).delete();
            });

          return Promise.all(p2);
        });
        p1.push(p0);
        return dispatch("saveTransaction", Promise.all(p1), { root: true });
      }

    }
  };

  return submodule;
};

VuexMapper.prototype.documentMixin = function documentMixin (name, ref) {
    var fields = ref.fields;
    var embeddedIn = ref.embeddedIn;
    var embedsMany = ref.embedsMany;
    var belongsTo = ref.belongsTo;
    var hasAndBelongsToMany = ref.hasAndBelongsToMany;


  var vuexMapper = this;

  // ie subTask
  var modelName = name;
  // ie subTasks
  var collectionName = pluralize(modelName);
  // ie subTask
  var parentPropName = embeddedIn;

  var subcollections = embedsMany || [];

  var belongsToReferenceNames = belongsTo || [];

  var habtm = hasAndBelongsToMany || [];

  var mixin = {

    props: {
      store: {
        type: Object,
        required: true
      },
      id: {
        type: String,
        required: true
      },
      docRef: {
        type: Object,
        required: true
      }
    },

    data: function() {
      return {
        parentPropName: parentPropName,
        collectionName: collectionName
      };
    },

    computed: {

      $_documentMixin_docState: function() {
          var this$1 = this;

        // TODO all doc models get recomputed when just one doc is added.
        // In fact, it gets recomputed twice per document. Is it possible to
        // get it to recompute once for just the document that gets added/changed?
        // I might have to ditch vuexfire to store state collections as objects
        // with their ids as keys for efficient lookup. In addition not trigger
        // a double recompute. Happens even when a doc is just modified (single key stroke)!
        return this.$_documentMixin_moduleFullState[this.collectionName].find(function (doc) {
          return doc.id === this$1.id;
        }) || {}; // state can be empty when things are still loading
      },

      $_documentMixin_moduleFullState: function() {
        return this.store.state[this.$_documentMixin_moduleName];
      },

      $_documentMixin_moduleName: function() {
        if (this.parentPropName) {
          return ((this.collectionName) + "-" + (this[this.parentPropName].id));
        } else {
          return this.collectionName;
        }
      }

    },

    methods: {

      update: function(payload) {
        payload.id = this.id;
        this.store.dispatch(this.$_documentMixin_moduleAccessorName("update"), payload);
      },

      destroy: function() {
          var this$1 = this;

        var promises = subcollections.map(function (subcollectionName) {
          return this$1.$_documentMixin_get(subcollectionName, { setRef: true })
            .then(function (objs) {
              return Promise.all(objs.map(function (obj) {
                return obj.destroy();
              }));
            });
        });
        promises.push(this.store.dispatch(this.$_documentMixin_moduleAccessorName("remove"), this.id));
        return Promise.all(promises).then(function () {
          return this$1.$_documentMixin_unregisterDynamicModules(subcollections);
        });
      },

      // options.setRef can be set to false so that onSnapshot is not registered. Useful
      // to make destroy() more efficient when the entire doc/subcollection tree is not 
      // neccessarily in Vuex state and we have to use db.get(). Though if it is in Vuex
      // state it is less efficient, but its more deterministic (won't
      // accidentally miss removal of something that hasn't sync'd its snapshot to Vuex
      // state) so I'll keep using db.get(). This syncing problem is only an issue if there
      // is sharing, which is not on the roadmap, so I could add conditional db.get() if
      // subcollections are not loaded into Vuex state. If I'm to release this as a package
      // others will use sharing and therefore it needs to stay as is.
      // This is written unlike the computed subcollection property, which exclusively uses
      // setRef and Vuex State. The problem with using state here is if its not already
      // loaded, the first time you call the subcollection property, Vuex state will not
      // be loaded.
      $_documentMixin_get: function(subcollectionName, options) {
          var this$1 = this;
          if ( options === void 0 ) options={};

        var submoduleGet = this.$_documentMixin_submoduleAccessorName(subcollectionName, "get");
        var Submodel = vuexMapper.lookupModel(subcollectionName);

        this.$_documentMixin_registerDynamicModule(
          subcollectionName,
          this.docRef.collection(subcollectionName),
          options
        );

        return this.store.dispatch(submoduleGet).then(function (docRefs) {
          return docRefs.map(function (docRef) {
            var modelArgs = {
              propsData: {
                store: this$1.store,
                id: docRef.id,
                docRef: docRef
              }
            };
            modelArgs.propsData[modelName] = this$1; // set parent object
            return new Submodel(modelArgs);
          });
        });
      },

      $_documentMixin_findOrCreateModule: function $_documentMixin_findOrCreateModule(collectionName) {
        modules[collectionName] = modules[collectionName] || vuexMapper.vuexModule({ name: collectionName });
        return modules[collectionName];
      },

      $_documentMixin_registerDynamicModule: function(subcollectionName, subcollectionRef, options) {
          if ( options === void 0 ) options={};

        if (!registeredDynamicModules[this.$_documentMixin_submoduleName(subcollectionName)]) {
          registeredDynamicModules[this.$_documentMixin_submoduleName(subcollectionName)] = true;
          this.store.registerModule(
            this.$_documentMixin_submoduleName(subcollectionName),
            this.$_documentMixin_findOrCreateModule(subcollectionName)
          );
          if (options.setRef !== false) {
            this.store.dispatch(this.$_documentMixin_submoduleAccessorName(subcollectionName, "setRef"), {ref: subcollectionRef, parentDocId: this.id});
          }
        }
      },

      $_documentMixin_unregisterDynamicModules: function(subcollections) {
          var this$1 = this;

        return Promise.all(subcollections.map(function (subcollectionName) {
          return this$1.store.dispatch(this$1.$_documentMixin_submoduleAccessorName(subcollectionName, "unsetRef")).then(function () {
            this$1.store.unregisterModule(this$1.$_documentMixin_submoduleName(subcollectionName));
            delete registeredDynamicModules[this$1.$_documentMixin_submoduleName(subcollectionName)];
          });
        }));
      },

      $_documentMixin_moduleAccessorName: function(actionName) {
        return ((this.$_documentMixin_moduleName) + "/" + actionName);
      },

      $_documentMixin_submoduleName: function(subcollectionName) {
        return (subcollectionName + "-" + (this.id));
      },

      $_documentMixin_submoduleAccessorName: function(submoduleName, actionName) {
        return ((this.$_documentMixin_submoduleName(submoduleName)) + "/" + actionName);
      },

      $_documentMixin_submoduleCollectionState: function(subcollectionName) {
        return this.$_documentMixin_submoduleFullState(subcollectionName)[subcollectionName] || [];
      },

      $_documentMixin_submoduleFullState: function(subcollectionName) {
        return this.store.state[this.$_documentMixin_submoduleName(subcollectionName)] || {};
      }

    }
  };

  if (parentPropName) {
    mixin.props[parentPropName] = {
      type: Object,
      required: true
    };
  }

  fields.forEach(function (getter) {
    mixin.computed[getter] = function() {
      return this.$_documentMixin_docState[getter];
    };
  });

  // ie subTasks
  subcollections.forEach(function (subcollectionName) {

    var SubModel = vuexMapper.lookupModel(subcollectionName);

    // todo.subTasks
    mixin.computed[subcollectionName] = function() {
        var this$1 = this;


      var subcollectionRef = this.docRef.collection(subcollectionName);
      this.$_documentMixin_registerDynamicModule(subcollectionName, subcollectionRef);

      var models = this.$_documentMixin_submoduleCollectionState(subcollectionName).map(function (t) {
        var modelArgs = {
          propsData: {
            store: this$1.store,
            id: t.id,
            docRef: subcollectionRef.doc(t.id)
          }
        };
        modelArgs.propsData[modelName] = this$1; // set parent object
        return new SubModel(modelArgs);
      });

      // todo.subTasks.create()
      models.create = function (payload) {
        var submoduleAdd = this$1.$_documentMixin_submoduleAccessorName(subcollectionName, "add");
        return this$1.store.dispatch(submoduleAdd, payload);
      };

      return models;
    };

  });

  // ie hope
  belongsToReferenceNames.forEach(function (referenceName) {
    var ReferenceModel = vuexMapper.lookupModel(referenceName);

    // category.hope
    mixin.computed[referenceName] = function() {
      var rootRef = this.docRef.firestore;
      var rootCollectionRef = rootRef.collection(referenceName);
      var referenceId = this.$_documentMixin_docState[(referenceName + "Id")];
      var modelArgs = {
        propsData: {
          store: this.store,
          id: referenceId,
          docRef: rootCollectionRef.doc(referenceId)
        }
      };
      // no parent for top-level references although, each creates its own instance
      // so it probably would be ok. Object model I don't expect to require this though
      // and it might be confusing.
      // modelArgs.propsData[modelName] = this;
      return new ReferenceModel(modelArgs);
    };
  });

  // ie hopes
  // TODO skipping refactor as this implementation will be replaced if used in production.
  // Maybe I should rip it out then so I don't forget.
  habtm.forEach(function (rootCollectionName) {

    var joinCollectionName = [collectionName, rootCollectionName]
      .sort().join("_");
    var RootModel = vuexMapper.lookupModel(rootCollectionName);

    mixin.computed[rootCollectionName] = function() {
        var this$1 = this;

      var rootRef = this.docRef.firestore;
      var rootCollectionRef = rootRef.collection(rootCollectionName);
      return this.store.state[joinCollectionName][joinCollectionName]
        .filter(function (doc) {
          return doc[(collectionName + "Id")] === this$1.id;
        })
        .map(function (doc) {
          var rootDocId = doc[(rootCollectionName + "Id")];
          var modelArgs = {
            propsData: {
              store: this$1.store,
              id: rootDocId,
              docRef: rootCollectionRef.doc(rootDocId)
            }
          };
          modelArgs.propsData[modelName] = this$1; // set parent object
          return new RootModel(modelArgs);
        });
    };

    // ie Hope
    // TODO skipping refactor. Rip out?
    // TODO Change to category.hopes.create(...)
    var rootModelName = pluralize.singular(rootCollectionName);
    rootModelName = camelcase(rootModelName, {pascalCase: true});
    mixin.methods[("add" + rootModelName)] = function(rootDocId) {
      // TODO if you have not called the collection accessor above,
      // the module will not be registered.
      // Add registerDynamicModule
      // Moot.
      var payload = {};
      if (collectionName <= rootCollectionName) {
        payload.id = (this.id) + "_" + rootDocId;
      } else {
        payload.id = rootDocId + "_" + (this.id);
      }
      var exists = !!this.store.state[joinCollectionName][joinCollectionName]
        .find(function (doc) {
          return doc.id === payload.id;
        });
      if (exists) {
        return Promise.resolve(null);
      } else {
        payload[(collectionName + "Id")] = this.id;
        payload[(rootCollectionName + "Id")] = rootDocId;
        return this.store.dispatch((joinCollectionName + "/addWithId"), payload);
      }
    };
  });

  return mixin;

};

VuexMapper.prototype.documentClassMethods = function documentClassMethods (ref) {
    var store = ref.store;
    var db = ref.db;
    var klass = ref.klass;
    var collectionName = ref.collectionName;
    var joinsWith = ref.joinsWith;


  var MODULE_NAME = collectionName;

  modules[collectionName] = this.vuexModule({ name: collectionName, joinsWith: joinsWith });
  store.registerModule(
    MODULE_NAME,
    modules[collectionName]
  );

  klass.setCollectionRef = function() {
    var ref = db.collection(collectionName);
    store.dispatch((collectionName + "/setRef"), {ref: ref, parentDocId: null});
    return ref;
  };

  // Assign to computed property to make computed.
  klass.all = function() {
    // TODO Wow all Category objects are recreated when one is added.
    // In fact, they're recreated twice (I think this might be a vuexfire
    // bug that needs to be fixed)!
    // There is the convenience of collection onSnapshot keeping the
    // order, which is a performance benefit, though probably faster
    // to order yourself and track docRef snapshots. However, both
    // strategies might be under the threshold of human lag detection.
    // Also, tracking collections may save on number of transactions /
    // cost of firestore.
    return store.state[MODULE_NAME][collectionName];
    // return store.state[MODULE_NAME][collectionName].map((state) => {
    // if (this[`${collectionName}Ref`] !== undefined) {
    //   return new klass({
    //     propsData: {
    //       store: store,
    //       id: state.id,
    //       docRef: this[`${collectionName}Ref`].doc(state.id)
    //     }
    //   });
    // }
    // })
    // .filter((obj) => obj);
  };

  klass.create = function(doc) {
    return store.dispatch((MODULE_NAME + "/add"), doc);
  };

};

VuexMapper.firebaseMutations = firebaseMutations;

return VuexMapper;

})));
