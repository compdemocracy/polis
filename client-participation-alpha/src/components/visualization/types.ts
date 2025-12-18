export interface BaseCluster {
  id: number
  x: number
  y: number
  count: number
  groupId: number
  members: number[]
}

export interface Hull {
  groupId: number
  hull: [number, number][] | null
  points: [number, number][]
  participantCount: number
  center?: [number, number]
}

export interface StatementWithType {
  tid: number
  pSuccess: number
  type: 'agree' | 'disagree'
}

export type StatementContext = 'consensus' | { groupId: number }

export interface SelectedStatement extends StatementWithType {
  context: StatementContext
}

export interface GroupVoteInfo {
  groupId: number
  agree: number
  disagree: number
  skip: number
  total: number
}

export interface UserPosition {
  x: number
  y: number
}
