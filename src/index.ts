import express from "express";

const app = express();
const port = 5000;

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`FixMate server listening on http://localhost:${port}`);
});
