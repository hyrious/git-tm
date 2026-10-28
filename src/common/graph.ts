import { snapshotId, type Snapshot } from './git';

export interface GraphEdge {
  readonly column: number;
  readonly dashed: boolean;
}

export interface GraphTrack {
  readonly depth: number;
  readonly incoming: GraphEdge[];
  readonly outgoing: GraphEdge[];
  readonly active: boolean;
}

interface Lane {
  readonly id: string;
  readonly dashed: boolean;
}

export class Graph {
  private lanes: (Lane | null)[] = [];

  append(snapshot: Snapshot): (GraphTrack | null)[] {
    const id = snapshotId(snapshot);
    let depth = this.lanes.findIndex(lane => lane?.id === id);
    if (depth < 0) depth = this.lanes.indexOf(null);
    if (depth < 0) depth = this.lanes.length;

    const next = this.lanes.slice();
    const tracks: (GraphTrack | null)[] = Array(Math.max(next.length, depth + 1)).fill(null);
    const node: GraphTrack = { depth, incoming: [], outgoing: [], active: true };
    tracks[depth] = node;
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      if (!lane) continue;
      const edge = { column: i, dashed: lane.dashed };
      if (lane.id === id) {
        node.incoming.push(edge);
        next[i] = null;
      } else {
        tracks[i] = { depth: i, incoming: [edge], outgoing: [edge], active: false };
      }
    }

    const dashed = snapshot.kind === 'working-tree';
    for (const parent of snapshot.parents) {
      let column = next.findIndex(lane => lane?.id === parent && lane.dashed === dashed);
      if (column < 0) {
        column = next[depth] == null ? depth : next.indexOf(null);
        if (column < 0) column = next.length;
        next[column] = { id: parent, dashed };
      }
      node.outgoing.push({ column, dashed });
    }
    while (next.length && next.at(-1) == null) next.pop();
    this.lanes = next;
    return tracks;
  }
}
