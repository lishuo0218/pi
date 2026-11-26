// Entry: mount the app with the persisted/system theme applied pre-render.
import { render } from "preact";
import { App } from "./app";
import { initTheme } from "./theme";
import { installPathDropGuard } from "./path-drag";
import { installChipCopy } from "./user-chips";
import "./style.css";

initTheme();
// Only the composer takes tree paths; the rest of the page must refuse them.
installPathDropGuard();
// Copying a message chip must yield its path, not the file name it draws.
installChipCopy();
render(<App />, document.getElementById("app") as HTMLElement);
