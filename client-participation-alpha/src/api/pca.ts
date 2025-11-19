import PolisNet from '../lib/net';

export interface GroupCluster {
  id: number;
  center: number[];
  members: number[];
}

export interface BaseClusters {
  x: number[];
  y: number[];
  id: number[];
  count: number[];
  members?: number[][];
}

export interface ConsensusItem {
  tid: number;
  'n-success': number;
  'n-trials': number;
  'p-success': number;
  'p-test': number;
}

export interface Consensus {
  agree: ConsensusItem[];
  disagree: ConsensusItem[];
}

export interface GroupVotes {
  'n-members': number;
  votes: {
    [tid: string]: {
      A: number; // Agree
      D: number; // Disagree
      S: number; // Skip
    };
  };
}

export interface RepnessItem {
  tid: number;
  'n-agree'?: number;
  'n-success': number;
  'n-trials': number;
  'p-success': number;
  'p-test': number;
  'repness': number;
  'repness-test': number;
  'repful-for': 'agree' | 'disagree';
  'best-agree'?: boolean;
}

export interface PCAData {
  'group-clusters': GroupCluster[];
  'base-clusters': BaseClusters;
  consensus?: Consensus;
  'group-aware-consensus'?: {
    [tid: string]: number;
  };
  'group-votes'?: {
    [groupId: string]: GroupVotes;
  };
  repness?: {
    [groupId: string]: RepnessItem[];
  };
  mathTick?: number;
}

export async function fetchPCAData(conversationId: string): Promise<PCAData> {
  return await PolisNet.polisGet('/math/pca2', { conversation_id: conversationId });
}

