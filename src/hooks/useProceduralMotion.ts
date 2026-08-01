import { useCallback, useEffect, useRef } from 'react';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';

type MotionBone =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'head'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm';

const MOTION_BONES: readonly MotionBone[] = [
  'hips',
  'spine',
  'chest',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
];

interface BoneState {
  node: THREE.Object3D;
  rotation: THREE.Quaternion;
}

export function shouldUseProceduralMotion(
  animationUrls?: readonly string[],
): boolean {
  return !animationUrls || animationUrls.length === 0;
}

export function useProceduralMotion(vrm: VRM | null) {
  const elapsed = useRef(0);
  const bones = useRef(new Map<MotionBone, BoneState>());
  const wasEnabled = useRef(false);
  const offset = useRef(new THREE.Quaternion());
  const euler = useRef(new THREE.Euler(0, 0, 0, 'XYZ'));

  useEffect(() => {
    elapsed.current = 0;
    bones.current.clear();
    wasEnabled.current = false;
    if (!vrm?.humanoid) return;
    for (const name of MOTION_BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) {
        bones.current.set(name, {
          node,
          rotation: node.quaternion.clone(),
        });
      }
    }
  }, [vrm]);

  const apply = useCallback(
    (name: MotionBone, x: number, y: number, z: number) => {
      const bone = bones.current.get(name);
      if (!bone) return;
      euler.current.set(x, y, z, 'XYZ');
      offset.current.setFromEuler(euler.current);
      bone.node.quaternion.copy(bone.rotation).multiply(offset.current);
    },
    [],
  );

  return useCallback(
    (delta: number, speaking: boolean, enabled: boolean) => {
      if (!vrm?.humanoid) return;
      if (!enabled) {
        if (wasEnabled.current) {
          for (const bone of bones.current.values()) {
            bone.node.quaternion.copy(bone.rotation);
          }
        }
        wasEnabled.current = false;
        return;
      }

      wasEnabled.current = true;
      elapsed.current += Math.min(delta, 0.1);
      const t = elapsed.current;
      const breath = Math.sin(t * 1.75);
      const sway = Math.sin(t * 0.72);
      const conversational = speaking ? Math.sin(t * 3.1) : 0;

      apply('hips', 0, sway * 0.018, sway * 0.012);
      apply('spine', breath * 0.013, sway * 0.018, sway * 0.01);
      apply('chest', breath * 0.018, -sway * 0.015, -sway * 0.008);
      apply(
        'head',
        speaking ? conversational * 0.028 : breath * 0.008,
        sway * 0.045,
        -sway * 0.018,
      );

      const talkArm = speaking ? conversational * 0.07 : breath * 0.012;
      apply('leftShoulder', 0, 0, 0.08 + talkArm * 0.25);
      apply('rightShoulder', 0, 0, -0.08 - talkArm * 0.25);
      apply('leftUpperArm', 0.06, 0, 1.08 + talkArm);
      apply('rightUpperArm', 0.06, 0, -1.08 - talkArm);
      apply('leftLowerArm', 0, 0.04, 0.08 + talkArm * 0.35);
      apply('rightLowerArm', 0, -0.04, -0.08 - talkArm * 0.35);
    },
    [apply, vrm],
  );
}
