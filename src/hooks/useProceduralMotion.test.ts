import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  advanceElapsed,
  applyPose,
  clampBlend,
  captureBones,
  MAX_FRAME_DELTA,
  MOTION_BONES,
  proceduralPose,
  restorePose,
  shouldUseProceduralMotion,
  type BoneState,
  type MotionBone,
} from './useProceduralMotion';

/**
 * Minimal humanoid stand-in. Every bone starts at a deliberately non-identity
 * rotation so the tests can prove the pose is composed onto the model's rest
 * rotation rather than replacing it.
 */
const REST_ANGLE = 0.25;

function restQuaternion() {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(REST_ANGLE, REST_ANGLE, REST_ANGLE, 'XYZ'),
  );
}

function fakeVrm(bones: readonly MotionBone[] = MOTION_BONES) {
  const nodes = new Map<MotionBone, THREE.Object3D>();
  for (const name of bones) {
    const node = new THREE.Object3D();
    node.quaternion.copy(restQuaternion());
    nodes.set(name, node);
  }
  const vrm = {
    humanoid: {
      getNormalizedBoneNode: (name: string) =>
        nodes.get(name as MotionBone) ?? null,
    },
  } as unknown as VRM;
  return { nodes, vrm };
}

describe('procedural motion fallback', () => {
  it('runs when the current action has no VRMA clips', () => {
    expect(shouldUseProceduralMotion()).toBe(true);
    expect(shouldUseProceduralMotion([])).toBe(true);
  });

  it('yields to a configured VRMA clip', () => {
    expect(shouldUseProceduralMotion(['idle.vrma'])).toBe(false);
  });
});

describe('advanceElapsed', () => {
  it('accumulates ordinary frame times', () => {
    expect(advanceElapsed(1, 0.016)).toBeCloseTo(1.016, 6);
  });

  it('clamps a long gap so a stalled window cannot jump the pose', () => {
    // A backgrounded window can hand back multi-second deltas; without the
    // clamp the character snaps to an unrelated phase of the animation.
    expect(advanceElapsed(0, 5)).toBeCloseTo(MAX_FRAME_DELTA, 6);
    expect(advanceElapsed(2, 5)).toBe(advanceElapsed(2, MAX_FRAME_DELTA));
  });
});

describe('proceduralPose', () => {
  it('covers every motion bone', () => {
    const pose = proceduralPose(1.2, false);
    for (const name of MOTION_BONES) {
      expect(pose[name]).toHaveLength(3);
      for (const value of pose[name]) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('lowers both arms, which is what keeps the model out of a T-pose', () => {
    const pose = proceduralPose(0, false);
    // The normalised rig is a canonical T-pose, so the arms need roughly a
    // radian of roll to hang down. Mirrored sign on each side.
    expect(pose.leftUpperArm[2]).toBeGreaterThan(1);
    expect(pose.rightUpperArm[2]).toBeLessThan(-1);
  });

  it('keeps torso and head motion subtle', () => {
    for (const elapsed of [0, 0.7, 1.9, 4.4, 12.5]) {
      const pose = proceduralPose(elapsed, true);
      for (const name of ['hips', 'spine', 'chest', 'head'] as const) {
        for (const value of pose[name]) {
          expect(Math.abs(value)).toBeLessThan(0.1);
        }
      }
    }
  });

  it('differs while speaking so the character reacts to the assistant', () => {
    const elapsed = 1.4;
    const idle = proceduralPose(elapsed, false);
    const speaking = proceduralPose(elapsed, true);
    expect(speaking.head[0]).not.toBeCloseTo(idle.head[0], 6);
    expect(speaking.leftUpperArm[2]).not.toBeCloseTo(idle.leftUpperArm[2], 6);
  });

  it('is deterministic for a given instant', () => {
    expect(proceduralPose(3.3, true)).toEqual(proceduralPose(3.3, true));
  });
});

describe('captureBones', () => {
  it('captures every available bone with its rest rotation', () => {
    const { nodes, vrm } = fakeVrm();
    const bones = captureBones(vrm);
    expect(bones.size).toBe(MOTION_BONES.length);
    const head = bones.get('head')!;
    expect(head.node).toBe(nodes.get('head'));
    expect(head.rotation.angleTo(restQuaternion())).toBeCloseTo(0, 6);
    // The captured rotation must be a copy: later posing must not mutate it.
    head.node.quaternion.set(0, 0, 0, 1);
    expect(head.rotation.angleTo(restQuaternion())).toBeCloseTo(0, 6);
  });

  it('skips bones the model does not expose', () => {
    const { vrm } = fakeVrm(['hips', 'head']);
    expect([...captureBones(vrm).keys()]).toEqual(['hips', 'head']);
  });

  it('returns nothing without a humanoid instead of throwing', () => {
    expect(captureBones(null).size).toBe(0);
    expect(captureBones({ humanoid: null } as unknown as VRM).size).toBe(0);
  });
});

describe('clampBlend', () => {
  it('keeps the blend inside the unit range', () => {
    expect(clampBlend(0.4)).toBe(0.4);
    expect(clampBlend(-3)).toBe(0);
    expect(clampBlend(9)).toBe(1);
  });

  it('treats a non-finite blend as fully yielding, never as full takeover', () => {
    expect(clampBlend(Number.NaN)).toBe(0);
    expect(clampBlend(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('applyPose and restorePose', () => {
  function poseBones(): {
    bones: Map<MotionBone, BoneState>;
    nodes: Map<MotionBone, THREE.Object3D>;
  } {
    const { nodes, vrm } = fakeVrm();
    return { bones: captureBones(vrm), nodes };
  }

  it('composes the offset onto the rest rotation rather than replacing it', () => {
    const { bones, nodes } = poseBones();
    applyPose(bones, proceduralPose(0.5, false));
    const head = nodes.get('head')!;
    expect(head.quaternion.angleTo(restQuaternion())).toBeGreaterThan(0);
    // A near-zero torso offset must stay near the rest pose, which would not
    // hold if the pose overwrote the rotation outright.
    expect(head.quaternion.angleTo(restQuaternion())).toBeLessThan(0.2);
  });

  it('moves the arms far from rest, mirrored on each side', () => {
    const { bones, nodes } = poseBones();
    applyPose(bones, proceduralPose(0, false));
    expect(
      nodes.get('leftUpperArm')!.quaternion.angleTo(restQuaternion()),
    ).toBeGreaterThan(0.9);
    expect(
      nodes.get('rightUpperArm')!.quaternion.angleTo(restQuaternion()),
    ).toBeGreaterThan(0.9);
  });

  it('restores every bone exactly, so a VRMA clip inherits a clean pose', () => {
    const { bones, nodes } = poseBones();
    applyPose(bones, proceduralPose(2.5, true));
    restorePose(bones);
    for (const node of nodes.values()) {
      expect(node.quaternion.angleTo(restQuaternion())).toBeCloseTo(0, 6);
    }
  });

  it('stays restored when called repeatedly instead of drifting', () => {
    const { bones, nodes } = poseBones();
    applyPose(bones, proceduralPose(2.5, true));
    restorePose(bones);
    restorePose(bones);
    restorePose(bones);
    expect(
      nodes.get('leftUpperArm')!.quaternion.angleTo(restQuaternion()),
    ).toBeCloseTo(0, 6);
  });

  it('ignores bones the model does not expose', () => {
    const { vrm } = fakeVrm(['hips', 'head']);
    const bones = captureBones(vrm);
    expect(() => applyPose(bones, proceduralPose(1, true))).not.toThrow();
    expect(() => restorePose(bones)).not.toThrow();
  });

  it('leaves the bones to the clip at blend 0', () => {
    const { bones, nodes } = poseBones();
    const posed = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.9, 0.1, -0.4, 'XYZ'),
    );
    // Stand in for what the VRMA mixer wrote this frame.
    for (const node of nodes.values()) node.quaternion.copy(posed);

    applyPose(bones, proceduralPose(1.5, false), 0);

    for (const node of nodes.values()) {
      expect(node.quaternion.angleTo(posed)).toBeCloseTo(0, 6);
    }
  });

  it('lands between the clip pose and the fallback at a partial blend', () => {
    const { bones, nodes } = poseBones();
    const posed = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.9, 0.1, -0.4, 'XYZ'),
    );
    const arm = nodes.get('leftUpperArm')!;
    arm.quaternion.copy(posed);

    const full = poseBones();
    applyPose(full.bones, proceduralPose(1.5, false), 1);
    const fallback = full.nodes.get('leftUpperArm')!.quaternion.clone();

    applyPose(bones, proceduralPose(1.5, false), 0.5);

    // Strictly between the two ends: this is the crossfade that stops the model
    // snapping into its T-pose while a clip loads or fades.
    const toClip = arm.quaternion.angleTo(posed);
    const toFallback = arm.quaternion.angleTo(fallback);
    expect(toClip).toBeGreaterThan(0.01);
    expect(toFallback).toBeGreaterThan(0.01);
    expect(toClip).toBeLessThan(posed.angleTo(fallback));
    expect(toFallback).toBeLessThan(posed.angleTo(fallback));
  });

  it('moves further toward the fallback as the blend rises', () => {
    const posed = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.9, 0.1, -0.4, 'XYZ'),
    );
    const distances = [0.25, 0.5, 0.9].map((blend) => {
      const { bones, nodes } = poseBones();
      const arm = nodes.get('leftUpperArm')!;
      arm.quaternion.copy(posed);
      applyPose(bones, proceduralPose(1.5, false), blend);
      return arm.quaternion.angleTo(posed);
    });
    expect(distances[1]).toBeGreaterThan(distances[0]);
    expect(distances[2]).toBeGreaterThan(distances[1]);
  });

  it('reuses caller scratch objects without leaking state between bones', () => {
    const { bones, nodes } = poseBones();
    const scratch = {
      euler: new THREE.Euler(0, 0, 0, 'XYZ'),
      offset: new THREE.Quaternion(),
      target: new THREE.Quaternion(),
    };
    applyPose(bones, proceduralPose(1.1, false), 1, scratch);
    const withScratch = nodes.get('leftLowerArm')!.quaternion.clone();

    restorePose(bones);
    applyPose(bones, proceduralPose(1.1, false));
    expect(
      nodes.get('leftLowerArm')!.quaternion.angleTo(withScratch),
    ).toBeCloseTo(0, 6);
  });
});
