// Redux/entity adapter for the Redux-free current-space store.
// Kept separate from spaceCurrentStore.ts so the state container remains
// statically analyzable and free of React/Redux import cycles.

import { useSelector } from "react-redux";
import { selectEntities } from "../../database/dbSlice";
import { createSpaceKey } from "./spaceKeys";
import {
  getCurrentSpaceId,
  getCurrentSpaceRaw,
  useStoreSnapshot,
} from "./spaceCurrentStore";
import type { SpaceData } from "../../app/types";

const getSpaceUpdatedAt = (space: any): number =>
  space ? Number(space.updatedAt) || 0 : 0;

/**
 * Resolve current space with entity fallback.
 * Accepts entities as parameter so it can be called from both React and
 * non-React contexts.
 */
export function getCurrentSpace(
  entities: Record<string, any>,
): SpaceData | null {
  const spaceId = getCurrentSpaceId();
  if (!spaceId) return null;

  const stored = getCurrentSpaceRaw();
  const entity = entities[createSpaceKey.space(spaceId)] as SpaceData | undefined;
  if (!stored) return entity ?? null;
  if (!entity) return stored;
  return getSpaceUpdatedAt(entity) > getSpaceUpdatedAt(stored) ? entity : stored;
}

/**
 * Convenience hook: reads both module store (currentSpace state) and
 * Redux (db entities) to resolve current space with entity fallback.
 * Replaces useAppSelector(selectCurrentSpace) in consumers that don't
 * already subscribe to entities.
 */
export function useCurrentSpaceFromEntity(): SpaceData | null {
  useStoreSnapshot();
  const entities = useSelector(selectEntities as (state: any) => Record<string, any>);
  return getCurrentSpace(entities);
}