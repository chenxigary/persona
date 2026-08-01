import { useCallback, useRef } from 'react';
import type { VRM } from '@pixiv/three-vrm';
import {
  advanceVisemePhase,
  smoothMouthLevel,
  targetMouthLevel,
  VISEMES,
  visemeWeights,
} from '../lip-sync';

export function useAmplitudeLipSync(vrm: VRM | null) {
  const smoothed = useRef(0);
  const phase = useRef(0);

  return useCallback(
    (delta: number, level: number, speaking: boolean) => {
      if (!vrm?.expressionManager) return;

      smoothed.current = smoothMouthLevel(
        smoothed.current,
        targetMouthLevel(level, speaking),
        delta,
      );
      phase.current = advanceVisemePhase(phase.current, smoothed.current, delta);

      const weights = visemeWeights(phase.current, smoothed.current);
      for (let index = 0; index < VISEMES.length; index += 1) {
        vrm.expressionManager.setValue(VISEMES[index], weights[index]);
      }
    },
    [vrm],
  );
}
