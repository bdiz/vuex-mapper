// BEGIN vuexmodule stuff
import { firebaseAction, firebaseMutations } from "vuexfire";
// import debounce from 'lodash.debounce';

// BEGIN documentMapper and documentClassMethods stuff
import pluralize from "pluralize";
import camelCase from "camelcase";
import kebabCase from "lodash.kebabcase";

// BEGIN vuexmodule stuff
const refs = {};

// TODO in the future if this needs to be customized per model, it can be passed
// in via setRef().
const queryFn = function(ref, context) {
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
const modules = {};
const registeredDynamicModules = {};

class VuexMapper {

  constructor(parentRequire, { currentTime }) {
    this.parentRequire = parentRequire;
    this.currentTime = currentTime;
    this.modelRegistration = {};
  }

  lookupModel(collectionName) {
    let modelName = pluralize.singular(collectionName);
    // TODO theres gotta be a way with webpack resolve.modules
    // https://stackoverflow.com/questions/51327159/allow-dependency-to-require-from-root-package-in-webpack
    // let fileName = `uvmgen-app/src/store/models/${kebabCase(modelName)}`;
    // return require(fileName);
    return this.modelRegistration[modelName];
  }

  registerModel(collectionName, model) {
    let modelName = pluralize.singular(collectionName);
    this.modelRegistration[modelName] = model;
  }

  vuexModule({name, joinsWith}) {

    // subTasks
    let collectionName = name;
    let joinCollectionNames = (joinsWith || []).map((otherName) => {
      return [collectionName, otherName].sort().join("_");
    });
    let currentTime = this.currentTime;

    let submodule = {
      namespaced: true,
      modules: {
      },

      state: () => {
        let s = {
          refKey: ""
        };
        s[collectionName] = [];
        return s;
      },

      getters: {
      },

      mutations: {

        setRef (state, {ref, parentDocId}) {
          if (parentDocId) {
            state.refKey = `${collectionName}-${parentDocId}`;
          } else {
            state.refKey = collectionName;
          }
          refs[state.refKey] = ref;
        }

      },

      actions: {

        setRef: firebaseAction((context, {ref, parentDocId}) => {
          if (refs[context.state.refKey] && ref.isEqual(refs[context.state.refKey])) {
            return Promise.resolve();
          }
          context.commit("setRef", {ref, parentDocId});
          let sortedRef = queryFn(refs[context.state.refKey], context);
          return context.bindFirebaseRef(collectionName, sortedRef);
        }),

        unsetRef: firebaseAction(({state, unbindFirebaseRef}) => {
          unbindFirebaseRef(collectionName);
          delete refs[state.refKey];
        }),

        // TODO Part of old HABTM join implementation. Remove once implementation changes.
        addWithId: function({ state, rootState, dispatch }, payload={}) {
          let docRef = refs[state.refKey].doc(payload.id);
          delete payload.id;
          return dispatch(
            "saveTransaction",
            docRef.set({
              ...payload,
              authorId: rootState.user.uid,
              createdAt: currentTime()
            }),
            { root: true }
          );
        },

        add: function({ state, rootState, dispatch }, payload={}) {
          return dispatch(
            "saveTransaction",
            refs[state.refKey].add({
              ...payload,
              authorId: rootState.user.uid,
              createdAt: currentTime()
            }),
            { root: true }
          );
        },

        update: function ({ state, dispatch }, payload) {
          // TODO debounce, at least for tests, maybe for web, not for json
          //   tough to do unless update() is passed the entire payload.
          //   Probably need to do that anyways to make make-module generic
          //   but then we're trading small/frequent updates for large/
          //   infrequent updates.
          const id = payload.id;
          const attributes = Object.assign({}, payload);
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
            .then((snapshot) => {
              // Remove all the child docs
              return snapshot.docs.map((doc) => {
                return refs[context.state.refKey].doc(doc.ref.id);
              });
            });
        },

        remove: function({ state, rootState, dispatch }, id) {
          let p0 = refs[state.refKey].doc(id).delete();
          // TODO remove p1 once HABTM is removed/reimplemented w/o join collection.
          let p1 = joinCollectionNames.map((j) => {
            // MOOT not sure if rootState is guaranteed to have join sync'd.
            let p2 = rootState[j][j]
              .filter((state) => {
                return (state[`${collectionName}Id`] === id);
              })
              .map((state) => {
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
  }

  documentMixin(name, {
    fields,
    embeddedIn,
    embedsMany,
    belongsTo,
    hasAndBelongsToMany
  }) {

    let vuexMapper = this;

    // ie subTask
    let modelName = name;
    // ie subTasks
    let collectionName = pluralize(modelName);
    // ie subTask
    let parentPropName = embeddedIn;

    let subcollections = [];

    if (embedsMany) {
      for (let collectionName in embedsMany) {
        if (embedsMany.hasOwnProperty(collectionName)) {
          subcollections.push(collectionName);
          this.registerModel(collectionName, embedsMany[collectionName]);
        }
      }
    }

    let belongsToReferenceNames = [];

    if (belongsTo) {
      for (let referenceName in belongsTo) {
        if (belongsTo.hasOwnProperty(referenceName)) {
          belongsToReferenceNames.push(referenceName);
          this.registerModel(referenceName, belongsTo[referenceName]);
        }
      }
    }

    let habtm = [];

    if (hasAndBelongsToMany) {
      for (let collectionName in hasAndBelongsToMany) {
        if (hasAndBelongsToMany.hasOwnProperty(collectionName)) {
          habtm.push(collectionName);
          this.registerModel(collectionName, hasAndBelongsToMany[collectionName]);
        }
      }
    }

    let mixin = {

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
          // TODO all doc models get recomputed when just one doc is added.
          // In fact, it gets recomputed twice per document. Is it possible to
          // get it to recompute once for just the document that gets added/changed?
          // I might have to ditch vuexfire to store state collections as objects
          // with their ids as keys for efficient lookup. In addition not trigger
          // a double recompute.
          return this.$_documentMixin_moduleFullState[this.collectionName].find((doc) => {
            return doc.id === this.id;
          }) || {}; // state can be empty when things are still loading
        },

        $_documentMixin_moduleFullState: function() {
          return this.store.state[this.$_documentMixin_moduleName];
        },

        $_documentMixin_moduleName: function() {
          if (this.parentPropName) {
            return `${this.collectionName}-${this[this.parentPropName].id}`;
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
          let promises = subcollections.map((subcollectionName) => {
            return this.$_documentMixin_get(subcollectionName, { setRef: true })
              .then((objs) => {
                return Promise.all(objs.map((obj) => {
                  return obj.destroy();
                }));
              });
          });
          promises.push(this.store.dispatch(this.$_documentMixin_moduleAccessorName("remove"), this.id));
          return Promise.all(promises).then(() => {
            return this.$_documentMixin_unregisterDynamicModules(subcollections);
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
        $_documentMixin_get: function(subcollectionName, options={}) {
          let submoduleGet = this.$_documentMixin_submoduleAccessorName(subcollectionName, "get");
          let Submodel = vuexMapper.lookupModel(subcollectionName);

          this.$_documentMixin_registerDynamicModule(
            subcollectionName,
            this.docRef.collection(subcollectionName),
            options
          );

          return this.store.dispatch(submoduleGet).then((docRefs) => {
            return docRefs.map((docRef) => {
              let modelArgs = {
                propsData: {
                  store: this.store,
                  id: docRef.id,
                  docRef
                }
              };
              modelArgs.propsData[modelName] = this; // set parent object
              return new Submodel(modelArgs);
            });
          });
        },

        $_documentMixin_findOrCreateModule(collectionName) {
          modules[collectionName] = modules[collectionName] || vuexMapper.vuexModule({ name: collectionName });
          return modules[collectionName];
        },

        $_documentMixin_registerDynamicModule: function(subcollectionName, subcollectionRef, options={}) {
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
          return Promise.all(subcollections.map((subcollectionName) => {
            return this.store.dispatch(this.$_documentMixin_submoduleAccessorName(subcollectionName, "unsetRef")).then(() => {
              this.store.unregisterModule(this.$_documentMixin_submoduleName(subcollectionName));
              delete registeredDynamicModules[this.$_documentMixin_submoduleName(subcollectionName)];
            });
          }));
        },

        $_documentMixin_moduleAccessorName: function(actionName) {
          return `${this.$_documentMixin_moduleName}/${actionName}`;
        },

        $_documentMixin_submoduleName: function(subcollectionName) {
          return `${subcollectionName}-${this.id}`;
        },

        $_documentMixin_submoduleAccessorName: function(submoduleName, actionName) {
          return `${this.$_documentMixin_submoduleName(submoduleName)}/${actionName}`;
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

    fields.forEach((getter) => {
      mixin.computed[getter] = function() {
        return this.$_documentMixin_docState[getter];
      };
    });

    // ie subTasks
    subcollections.forEach((subcollectionName) => {

      let SubModel = vuexMapper.lookupModel(subcollectionName);

      // todo.subTasks
      mixin.computed[subcollectionName] = function() {

        let subcollectionRef = this.docRef.collection(subcollectionName);
        this.$_documentMixin_registerDynamicModule(subcollectionName, subcollectionRef);

        let models = this.$_documentMixin_submoduleCollectionState(subcollectionName).map((t) => {
          let modelArgs = {
            propsData: {
              store: this.store,
              id: t.id,
              docRef: subcollectionRef.doc(t.id)
            }
          };
          modelArgs.propsData[modelName] = this; // set parent object
          return new SubModel(modelArgs);
        });

        // todo.subTasks.create()
        models.create = (payload) => {
          let submoduleAdd = this.$_documentMixin_submoduleAccessorName(subcollectionName, "add");
          return this.store.dispatch(submoduleAdd, payload);
        };

        return models;
      };

    });

    // ie hope
    belongsToReferenceNames.forEach((referenceName) => {
      let ReferenceModel = vuexMapper.lookupModel(referenceName);

      // category.hope
      mixin.computed[referenceName] = function() {
        let rootRef = this.docRef.firestore;
        let rootCollectionRef = rootRef.collection(referenceName);
        let referenceId = this.$_documentMixin_docState[`${referenceName}Id`];
        let modelArgs = {
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
    habtm.forEach((rootCollectionName) => {

      let joinCollectionName = [collectionName, rootCollectionName]
        .sort().join("_");
      let RootModel = vuexMapper.lookupModel(rootCollectionName);

      mixin.computed[rootCollectionName] = function() {
        let rootRef = this.docRef.firestore;
        let rootCollectionRef = rootRef.collection(rootCollectionName);
        return this.store.state[joinCollectionName][joinCollectionName]
          .filter((doc) => {
            return doc[`${collectionName}Id`] === this.id;
          })
          .map((doc) => {
            let rootDocId = doc[`${rootCollectionName}Id`];
            let modelArgs = {
              propsData: {
                store: this.store,
                id: rootDocId,
                docRef: rootCollectionRef.doc(rootDocId)
              }
            };
            modelArgs.propsData[modelName] = this; // set parent object
            return new RootModel(modelArgs);
          });
      };

      // ie Hope
      // TODO skipping refactor. Rip out?
      // TODO Change to category.hopes.create(...)
      let rootModelName = pluralize.singular(rootCollectionName);
      rootModelName = camelCase(rootModelName, {pascalCase: true});
      mixin.methods[`add${rootModelName}`] = function(rootDocId) {
        // TODO if you have not called the collection accessor above,
        // the module will not be registered.
        // Add registerDynamicModule
        // Moot.
        let payload = {};
        if (collectionName <= rootCollectionName) {
          payload.id = `${this.id}_${rootDocId}`;
        } else {
          payload.id = `${rootDocId}_${this.id}`;
        }
        let exists = !!this.store.state[joinCollectionName][joinCollectionName]
          .find((doc) => {
            return doc.id === payload.id;
          });
        if (exists) {
          return Promise.resolve(null);
        } else {
          payload[`${collectionName}Id`] = this.id;
          payload[`${rootCollectionName}Id`] = rootDocId;
          return this.store.dispatch(`${joinCollectionName}/addWithId`, payload);
        }
      };
    });

    return mixin;

  }

  documentClassMethods({store, db, klass, collectionName, joinsWith}) {

    const MODULE_NAME = collectionName;

    modules[collectionName] = this.vuexModule({ name: collectionName, joinsWith });
    store.registerModule(
      MODULE_NAME,
      modules[collectionName]
    );

    klass.setCollectionRef = function() {
      let ref = db.collection(collectionName);
      store.dispatch(`${collectionName}/setRef`, {ref: ref, parentDocId: null});
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
      return store.state[MODULE_NAME][collectionName].map((state) => {
        return new klass({
          propsData: {
            store: store,
            id: state.id,
            docRef: this[`${collectionName}Ref`].doc(state.id)
          }
        });
      });
    };

    klass.create = function(doc) {
      store.dispatch(`${MODULE_NAME}/add`, doc);
    };

  }

}

VuexMapper.firebaseMutations = firebaseMutations;

export default VuexMapper;
