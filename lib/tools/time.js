// Time tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.


export const time = [
  {
    name: "get_current_time",
    description:
      "Get the current date and time. Defaults to the user's own clock; pass a place to get the time somewhere else.",
    parameters: {
      type: "object",
      properties: {
        place: {
          type: "string",
          description: "Somewhere other than here, e.g. 'Tokyo'. Leave empty for the user's own time.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const where = await ctx.resolvePlace(input.place);
    const now = new Date();
    // An unknown zone throws rather than falling back, and being wrong about
    // the time is worse than admitting which clock you read.
    const zone = where?.timezone;
    const options = zone ? { timeZone: zone } : {};
  
    try {
      return {
        place: where ? [where.city, where.region].filter(Boolean).join(", ") : "where the user is",
        time: now.toLocaleTimeString("en-US", { ...options, hour: "numeric", minute: "2-digit" }),
        date: now.toLocaleDateString("en-US", { ...options, weekday: "long", month: "long", day: "numeric", year: "numeric" }),
        timezone: zone ?? "the user's own clock",
      };
    } catch {
      return {
        place: "where the user is",
        time: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        date: now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
        note: `I don't know the timezone for ${input.place}, so this is the local clock.`,
      };
    }
    },
  },
];
