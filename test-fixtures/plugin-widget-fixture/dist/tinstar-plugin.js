// test-fixtures/plugin-widget-fixture/src/index.tsx
import React from "react";
function makeFixtureWidget(api) {
  return function FixtureWidget() {
    const [data, setData] = api.widget.useData();
    const deleteMe = api.widget.useDelete();
    const counter = data?.counter ?? 0;
    return /* @__PURE__ */ React.createElement("div", { "data-testid": "fixture-widget", style: {
      padding: 12,
      color: "#e5e7eb",
      background: "#111827",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 8
    } }, /* @__PURE__ */ React.createElement("div", { "data-testid": "fixture-counter", style: { fontSize: 20 } }, counter), /* @__PURE__ */ React.createElement("button", { "data-testid": "fixture-increment", onClick: () => setData({ counter: counter + 1 }) }, "+1"), /* @__PURE__ */ React.createElement("button", { "data-testid": "fixture-delete", onClick: () => deleteMe() }, "delete"));
  };
}
function activate(api) {
  const Component = makeFixtureWidget(api);
  return [
    api.widgets.register({
      type: "fixture-widget",
      component: Component,
      isContainer: false,
      defaultSize: { width: 320, height: 200 },
      minSize: { width: 200, height: 120 }
    }),
    api.widgets.register({
      type: "fixture-singleton-widget",
      component: Component,
      isContainer: false,
      defaultSize: { width: 320, height: 200 },
      minSize: { width: 200, height: 120 }
    })
  ];
}
export {
  activate
};
