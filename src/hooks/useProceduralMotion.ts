import { useCallback, useEffect, useRef } from 'react';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';

export type MotionBone =
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

export const MOTION_BONES: readonly MotionBone[] = [
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

/**
 * Upper bound on a single frame's contribution. Without it a stalled or
 * backgrounded window resumes with a large jump in the animation phase, which
 * reads as the character snapping into a new pose.
 */
export const MAX_FRAME_DELTA = 0.1;

export interface BoneState {
  node: THREE.Object3D;
  rotation: THREE.Quaternion;
}

/** Euler offsets in radians, composed onto the bone's captured rest rotation. */
export type BonePose = Readonly<
  Record<MotionBone, readonly [number, number, number]>
>;

interface PoseScratch {
  euler: THREE.Euler;
  offset: THREE.Quaternion;
  target: THREE.Quaternion;
}

function createScratch(): PoseScratch {
  return {
    euler: new THREE.Euler(0, 0, 0, 'XYZ'),
    offset: new THREE.Quaternion(),
    target: new THREE.Quaternion(),
  };
}

export function clampBlend(blend: number): number {
  if (!Number.isFinite(blend)) return 0;
  return Math.max(0, Math.min(1, blend));
}

export function shouldUseProceduralMotion(
  animationUrls?: readonly string[],
): boolean {
  return !animationUrls || animationUrls.length === 0;
}

export function advanceElapsed(previous: number, delta: number): number {
  return previous + Math.min(delta, MAX_FRAME_DELTA);
}

/**
 * The whole fallback pose for one instant. Offsets are relative to the
 * normalised humanoid rig, which three-vrm keeps in a canonical T-pose, so the
 * constant arm angles port across models rather than depending on how any
 * particular VRM authored its rest pose.
 */
export function proceduralPose(elapsed: number, speaking: boolean): BonePose {
  const breath = Math.sin(elapsed * 1.75);
  const sway = Math.sin(elapsed * 0.72);
  const conversational = speaking ? Math.sin(elapsed * 3.1) : 0;
  const talkArm = speaking ? conversational * 0.07 : breath * 0.012;

  return {
    hips: [0, sway * 0.018, sway * 0.012],
    spine: [breath * 0.013, sway * 0.018, sway * 0.01],
    chest: [breath * 0.018, -sway * 0.015, -sway * 0.008],
    head: [
      speaking ? conversational * 0.028 : breath * 0.008,
      sway * 0.045,
      -sway * 0.018,
    ],
    leftShoulder: [0, 0, 0.08 + talkArm * 0.25],
    rightShoulder: [0, 0, -0.08 - talkArm * 0.25],
    leftUpperArm: [0.06, 0, 1.08 + talkArm],
    rightUpperArm: [0.06, 0, -1.08 - talkArm],
    leftLowerArm: [0, 0.04, 0.08 + talkArm * 0.35],
    rightLowerArm: [0, -0.04, -0.08 - talkArm * 0.35],
  };
}

export function captureBones(vrm: VRM | null): Map<MotionBone, BoneState> {
  const bones = new Map<MotionBone, BoneState>();
  if (!vrm?.humanoid) return bones;
  for (const name of MOTION_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (node) bones.set(name, { node, rotation: node.quaternion.clone() });
  }
  return bones;
}

/**
 * Blends the fallback pose over whatever is already on the bones.
 *
 * `blend` is how much of the procedural pose to take: 1 replaces the bone
 * outright, 0 leaves it alone, and values in between interpolate. Callers pass
 * the inverse of the VRMA mixer's weight so the two never fight — the fallback
 * recedes exactly as a clip fades in, and returns as it fades out.
 */
export function applyPose(
  bones: ReadonlyMap<MotionBone, BoneState>,
  pose: BonePose,
  blend = 1,
  scratch: PoseScratch = createScratch(),
): void {
  const amount = clampBlend(blend);
  if (amount === 0) return;
  for (const name of MOTION_BONES) {
    const bone = bones.get(name);
    if (!bone) continue;
    const [x, y, z] = pose[name];
    scratch.euler.set(x, y, z, 'XYZ');
    scratch.offset.setFromEuler(scratch.euler);
    scratch.target.copy(bone.rotation).multiply(scratch.offset);
    if (amount >= 1) {
      bone.node.quaternion.copy(scratch.target);
    } else {
      bone.node.quaternion.slerp(scratch.target, amount);
    }
  }
}

/** Puts every captured bone back exactly where it was before the fallback ran. */
export function restorePose(bones: ReadonlyMap<MotionBone, BoneState>): void {
  for (const bone of bones.values()) {
    bone.node.quaternion.copy(bone.rotation);
  }
}

export function useProceduralMotion(vrm: VRM | null) {
  const elapsed = useRef(0);
  const bones = useRef(new Map<MotionBone, BoneState>());
  const wasEnabled = useRef(false);
  const scratch = useRef(createScratch());

  useEffect(() => {
    elapsed.current = 0;
    wasEnabled.current = false;
    bones.current = captureBones(vrm);
  }, [vrm]);

  return useCallback(
    (delta: number, speaking: boolean, blend: number) => {
      if (!vrm?.humanoid) return;
      const amount = clampBlend(blend);
      if (amount === 0) {
        // A clip owns the bones now. Hand back any bone the clip does not
        // animate, so a partial VRMA cannot strand it in the fallback pose.
        if (wasEnabled.current) restorePose(bones.current);
        wasEnabled.current = false;
        return;
      }

      wasEnabled.current = true;
      elapsed.current = advanceElapsed(elapsed.current, delta);
      applyPose(
        bones.current,
        proceduralPose(elapsed.current, speaking),
        amount,
        scratch.current,
      );
    },
    [vrm],
  );
}
