/// <reference lib="webworker" />
/**
 * Parses LDraw parts off the main thread. The page sends a one-line model
 * (data URL) plus the library to read from; the worker downloads and parses
 * every sub-file, flattens the result and returns it as Three.js JSON together
 * with the hole primitives found in the file tree. The main thread only runs
 * ObjectLoader.parse, so large parts (Spike motors, hubs) no longer freeze it.
 */
import * as THREE from "three";
import { LDrawLoader, clearLDrawCaches } from "../vendor/LDrawLoader.js";
import { LDrawConditionalLineMaterial } from "three/addons/materials/LDrawConditionalLineMaterial.js";
import { flattenLDrawRenderables } from "../ldraw-geometry";
import { classifySubpart } from "../ldraw-subparts";

type Init = { type: "init"; fileMap: Record<string, string> | null; libraries: string[] };
type Load = { type: "load"; id: number; base: string; source: string };
type Reset = { type: "reset" };
type Message = Init | Load | Reset;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let fileMap: Record<string, string> | null = null,
  libraries: string[] = [];

type Lane = { instance: LDrawLoader; ready: Promise<unknown>; tail: Promise<unknown> };
const lanes = new Map<string, Lane>();

const laneFor = (base: string): Lane => {
  let lane = lanes.get(base);
  if (lane) return lane;
  const instance = new LDrawLoader();
  instance.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  instance.setPartsLibraryPath(base);
  (instance as unknown as { fallbackLibraries: string[] }).fallbackLibraries = libraries.filter(
    (library) => library !== base,
  );
  if (fileMap) instance.setFileMap(fileMap);
  const ready = instance
    .preloadMaterials(base + "LDConfig.ldr")
    .catch(() => undefined);
  lane = { instance, ready, tail: Promise.resolve() };
  lanes.set(base, lane);
  return lane;
};

async function load(message: Load) {
  const lane = laneFor(message.base);
  await lane.ready;
  const tracker = lane.instance as unknown as { missingFiles?: Set<string> };
  tracker.missingFiles?.clear();
  const group = await lane.instance.loadAsync(message.source);
  const missing = tracker.missingFiles?.size ?? 0;
  let hits: { fileName: string; matrix: number[] }[] = [];
  try {
    const text = decodeURIComponent(message.source.slice(message.source.indexOf(",") + 1));
    hits = await (
      lane.instance as unknown as {
        collectSubparts: (
          text: string,
          classify: typeof classifySubpart,
        ) => Promise<{ fileName: string; matrix: number[] }[]>;
      }
    ).collectSubparts(text, classifySubpart);
  } catch {
    // Hole primitives are a bonus; the mesh is what matters.
  }
  const flat = flattenLDrawRenderables(group);
  flat.userData.subpartHits = hits;
  return { json: flat.toJSON(), missing };
}

scope.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "init") {
    fileMap = message.fileMap;
    libraries = message.libraries;
    lanes.forEach((lane) => fileMap && lane.instance.setFileMap(fileMap));
    return;
  }
  if (message.type === "reset") {
    clearLDrawCaches();
    lanes.forEach((lane) =>
      (lane.instance as unknown as { resetCaches?: () => void }).resetCaches?.(),
    );
    return;
  }
  const lane = laneFor(message.base);
  lane.tail = lane.tail
    .then(() => load(message))
    .then(
      (result) => scope.postMessage({ id: message.id, ...result }),
      (error: unknown) =>
        scope.postMessage({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
};

// Keeps THREE referenced so bundlers do not drop the side-effect imports.
void THREE.REVISION;
