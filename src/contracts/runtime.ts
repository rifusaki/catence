/** Paths owned by one isolated local Catence data store. */
export type CatencePaths = {
  root: string;
  database: string;
  raw: string;
  lake: string;
  staging: string;
  config: string;
  secrets: string;
  lock: string;
  /** Athlete-authored markdown document shared by the athlete and the agent. */
  athleteFile: string;
  /** Rolling snapshots of prior athlete-file content. Created on first write. */
  athleteFileHistory: string;
};
