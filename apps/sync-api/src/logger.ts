import pino from "pino";
import { appConfig } from "./config.js";

export const logger = pino({
  level: appConfig.logLevel,
  redact: {
    paths: ["req.headers.authorization", "token", "refreshToken"],
    remove: true
  }
});
