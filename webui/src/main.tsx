// Entry: mount the app with the persisted/system theme applied pre-render.
import { render } from "preact";
import { App } from "./app";
import { initTheme } from "./theme";
import "./style.css";

initTheme();
render(<App />, document.getElementById("app") as HTMLElement);
