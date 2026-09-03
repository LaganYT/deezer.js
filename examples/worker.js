import Deezer from "../src/index.js";

export default {
  async fetch() {
    const deezer = new Deezer();
    return Response.json({ compatible: typeof deezer.api === "function" });
  }
};
