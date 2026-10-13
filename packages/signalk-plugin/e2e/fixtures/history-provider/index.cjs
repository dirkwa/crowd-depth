// A stand-in for a history plugin such as signalk-questdb: it answers every
// query with the soundings the test hands it in E2E_HISTORY, stored exactly as
// Signal K received them (depth below the transducer, raw antenna position).
module.exports = (app) => ({
  id: "e2e-history-provider",
  name: "E2E history provider",
  schema: () => ({}),
  start() {
    const rows = JSON.parse(process.env.E2E_HISTORY ?? "[]");
    const inRange = (from, to) =>
      rows.filter((r) => {
        const t = Date.parse(r.time);
        return t >= Date.parse(from) && t < Date.parse(to);
      });
    app.registerHistoryApiProvider({
      async getValues(query) {
        const from = query.from.toString();
        const to = query.to.toString();
        return {
          context: "vessels.self",
          range: { from, to },
          values: query.pathSpecs.map((p) => ({
            path: p.path,
            method: p.aggregate,
          })),
          data: inRange(from, to).map((r) => [
            r.time,
            ...query.pathSpecs.map((p) =>
              p.path === "navigation.position"
                ? [r.longitude, r.latitude]
                : p.path.startsWith("environment.depth.")
                  ? r.depth
                  : null,
            ),
          ]),
        };
      },
      async getContexts() {
        return ["vessels.self"];
      },
      async getPaths() {
        return ["navigation.position", "environment.depth.belowTransducer"];
      },
    });
  },
  stop() {},
});
