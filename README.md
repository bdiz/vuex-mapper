# vuex-mapper alpha

This repo contains an ODM for Vuex and Firestore. Inspired by Mongoid. It uses vuexfire for binding snapshots to Vuex state.

The idea is to make it easy to create objects which map to your Vuex store.

## Getting started

```
npm install --save vuex-mapper
```

```javascript
import Vue from "vue";
import firebase from "firebase";
import VuexMapper from "vuex-mapper";
import SubTask from "./sub-task";

const currentTime = function() {
  return firebase.firestore.FieldValue.serverTimestamp();
};
const vuexMapper = new VuexMapper({ currentTime });

export default Vue.extend({
  mixins: [
    vuexMapper.documentMixin("todo", {
      fields: ["text"],
      embeddedIn: "category",
      embedsMany: { subTasks: SubTask }
    })
  ]
});
```

## TODO

Too many things to list. This library is incomplete and slow moving. PRs welcome.

## License

[MIT](LICENSE).
