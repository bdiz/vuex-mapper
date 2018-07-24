# vuex-mapper alpha

This repo contains an ODM for Vuex and Firestore. Inspired by Mongoid. It uses dynamic modules and vuexfire for binding snapshots to Vuex state.

The idea is to make it easy to create objects which map to your Vuex store.

This package is currently supported by webpack only due to how it auto-requires modules using `require.context()`.

## Getting started

```bash
npm install --save vuex-mapper
```

I'll try to get a compilable example available in the repo, but for now you an attempt to get your app going by following along here.

```javascript
// ./src/firestore.js
import firebase from "firebase";
import "firebase/firestore";

firebase.initializeApp({
  apiKey: process.env.VUE_APP_FIRESTORE_API_KEY,
  authDomain: process.env.VUE_APP_FIRESTORE_AUTH_DOMAIN,
  databaseURL: process.env.VUE_APP_FIRESTORE_DATABASE_URL,
  projectId: process.env.VUE_APP_FIRESTORE_PROJECT_ID
});

const firestore = firebase.firestore();
firestore.settings({ timestampsInSnapshots: true });

export default firestore;
```

```javascript
// ./src/vuex-mapper-instance.js
import VuexMapper from "vuex-mapper";

const requireModule = require.context('./models/', true);
const currentTime = function() {
  return firebase.firestore.FieldValue.serverTimestamp();
};

const vuexMapper = new VuexMapper(requireModule, { currentTime });
export default vuexMapper;
```

```javascript
// ./src/store/index.js
import Vue from "vue";
import Vuex from "vuex";
import VuexMapper from "vuex-mapper";
import vuexMapper from "../vuex-mapper";

Vue.use(Vuex);
const store = new Vuex.Store({

  strict: process.env.NODE_ENV !== "production",

  state: () => {
    return {
      user: null,
      openTransactions: 0
    };
  },

  getters: {
    store: function() {
      return store;
    },
    user: state => state.user,
    saving: state => !!state.openTransactions,
    isAuthenticated: state => !!state.user
  },

  mutations: {
    ...VuexMapper.firebaseMutations,
    setUser: function(state, { isAnonymous, uid }) {
      state.user = { isAnonymous, uid };
    },
    startTransaction: function(state) {
      state.openTransactions++;
    },
    endTransaction: function(state) {
      state.openTransactions--;
    }
  },

  actions: {
    saveTransaction: function(context, promise) {
      context.commit("startTransaction");
      return promise
        .then((ret) => {
          context.commit("endTransaction");
          return ret;
        });
    }
  }

});

export default store;

```

```javascript
// ./src/models/category.js
import Vue from "vue";
import firestore from "../firestore";
import store from "../store/index";
import vuexMapper from "../vuex-mapper-instance";

const Category = Vue.extend({
  mixins: [
    vuexMapper.documentMixin("category", {
      fields: ["text"],
      embedsMany: ["todos"]
    })
  ]
});

// Only need class methods for top-level collections (not subcollections)
vuexMapper.documentClassMethods({
  store,
  db,
  klass: Category,
  collectionName: "categories"
});

export default Category;
```

```javascript
// ./src/models/todo.js
import Vue from "vue";
import vuexMapper from "../vuex-mapper-instance";

export default Vue.extend({
  mixins: [
    vuexMapper.documentMixin("todo", {
      fields: ["text"],
      embeddedIn: "category",
      embedsMany: ["subTasks"]
    })
  ]
});
```

```javascript
// ./src/models/sub-task.js
import Vue from "vue";
import vuexMapper from "../vuex-mapper-instance";

export default Vue.extend({
  mixins: [
    vuexMapper.documentMixin("subTask", {
      fields: ["text"],
      embeddedIn: "todo"
    })  
  ]
});

```

Authenticate and call `store.setUser({uid: firestoreAuthId})`. For top-level collection you must call `Category.setCollectionRef()` in a `created()` hook of a component to allow vuexfire to update Vuex state.

Finally the fun happen. Now you can get at category state with `Category.all`. You can add categories with `Category.create({text: newCategoryText})`. Create a new Category model instance with:

```javascript
let category = new Category({
  propsData: {
    store: this.$store,
    id: id,
    docRef: this.categoriesRef.doc(id)
  }
});
```

And with a category instance you can call `category.text`, `category.update({text: updatedCategoryText})`, `category.destroy()`, `category.todos` and `let todo = category.todos.create({text: newTodoText})`. With the todo instance you can similarly call methods and computed properties to get at subTasks.

I hope thats enough to get you started. I know its a bit of a mess right now.

## TODO

Too many things to list.

At a high level I want to support all associations Mongoid does.

I'd also like this to be a Vuex plugin with less setup.

This library is incomplete and very alpha. PRs welcome.

## License

[MIT](LICENSE).
