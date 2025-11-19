import { useMemo, useState, useEffect } from 'react';
import { Group } from '@visx/group';
import { scaleLinear } from '@visx/scale';
import { motion } from 'motion/react';
import type { PCAData } from '../api/pca';
import type { Comment } from '../api/comments';
import { concaveHull } from '../utils/concaveHull';
import GroupIcon from './icons/GroupIcon';
import { getConversationToken } from '../lib/auth';

interface BaseCluster {
  id: number;
  x: number;
  y: number;
  count: number;
  groupId: number;
  members: number[];
}

interface PCAVisualizationProps {
  data: PCAData;
  comments?: Comment[] | null;
  conversationId?: string;
}

const CONCAVITY = 3;
const LENGTH_THRESHOLD = 200;

const width = 800;
const height = 600;
const margin = { top: 40, right: 40, bottom: 60, left: 60 };

const xMax = width - margin.left - margin.right;
const yMax = height - margin.top - margin.bottom;

// Colors for up to five groups - grayscale
const groupColors = ['#e0e0e0', '#e0e0e0', '#e0e0e0', '#e0e0e0', '#e0e0e0'];
const groupLetters = ['A', 'B', 'C', 'D', 'E'];

// Icon components for agree/disagree
function CheckCircleIcon({ fill, size = 22 }: { fill: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 1792 1792"
      xmlns="http://www.w3.org/2000/svg"
      height={size}
      width={size}
      style={{ display: 'block' }}
    >
      <path
        d="M1299 813l-422 422q-19 19-45 19t-45-19l-294-294q-19-19-19-45t19-45l102-102q19-19 45-19t45 19l147 147 275-275q19-19 45-19t45 19l102 102q19 19 19 45t-19 45zm141 83q0-148-73-273t-198-198-273-73-273 73-198 198-73 273 73 273 198 198 273 73 273-73 198-198 73-273zm224 0q0 209-103 385.5t-279.5 279.5-385.5 103-385.5-103-279.5-279.5-103-385.5 103-385.5 279.5-279.5 385.5-103 385.5 103 279.5 279.5 103 385.5z"
        fill={fill}
      />
    </svg>
  );
}

function BanIcon({ fill, size = 22 }: { fill: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 1792 1792"
      xmlns="http://www.w3.org/2000/svg"
      height={size}
      width={size}
      style={{ display: 'block' }}
    >
      <path
        d="M1440 893q0-161-87-295l-754 753q137 89 297 89 111 0 211.5-43.5t173.5-116.5 116-174.5 43-212.5zm-999 299l755-754q-135-91-300-91-148 0-273 73t-198 199-73 274q0 162 89 299zm1223-299q0 157-61 300t-163.5 246-245 164-298.5 61-298.5-61-245-164-163.5-246-61-300 61-299.5 163.5-245.5 245-164 298.5-61 298.5 61 245 164 163.5 245.5 61 299.5z"
        fill={fill}
      />
    </svg>
  );
}

type StatementContext = 'consensus' | { groupId: number };

// Helper function to select top consensus items
function selectTopConsensusItems(
  data: Record<string, number>,
  targetCount: number = 5,
  maxExcess: number = 10
): string[] {
  // Convert to array and sort descending by score
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  
  const selectedTids: string[] = [];
  let i = 0;
  
  while (i < entries.length) {
    // If we already have enough items, stop
    if (selectedTids.length >= targetCount) {
      break;
    }

    const currentScore = entries[i][1];
    const candidates: string[] = [];
    
    // Collect all items with the same score (using epsilon for float comparison)
    let j = i;
    while (j < entries.length && Math.abs(entries[j][1] - currentScore) < Number.EPSILON) {
      candidates.push(entries[j][0]);
      j++;
    }
    
    // Check if adding these candidates would exceed the limit
    // We allow exceeding if it's the very first group (to ensure we show something)
    // or if the total count is within tolerance
    if (selectedTids.length === 0 || (selectedTids.length + candidates.length <= targetCount + maxExcess)) {
      selectedTids.push(...candidates);
      i = j;
    } else {
      // If adding this group exceeds the limit and we already have items, stop here
      break;
    }
  }
  
  return selectedTids;
}

export default function PCAVisualization({ data, comments, conversationId }: PCAVisualizationProps) {
  const [isConsensusSelected, setisConsensusSelected] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [selectedStatement, setSelectedStatement] = useState<{
    tid: number;
    pSuccess: number;
    type: 'agree' | 'disagree';
    context: StatementContext;
  } | null>(null);
  const [userPid, setUserPid] = useState<number | null>(null);

  // Get current user's PID
  useEffect(() => {
    const updatePid = () => {
      if (conversationId) {
        const token = getConversationToken(conversationId);
        if (token && typeof token.pid === 'number' && token.pid >= 0) {
          setUserPid(token.pid);
        } else {
          // PID is -1 or invalid - user hasn't voted yet, so they don't have a position on the PCA
          setUserPid(null);
        }
      }
    };

    updatePid();

    const handleTokenUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.conversation_id === conversationId) {
        updatePid();
      }
    };

    window.addEventListener('polis-token-update', handleTokenUpdate);
    return () => window.removeEventListener('polis-token-update', handleTokenUpdate);
  }, [conversationId]);

  // Find the comment text for the selected statement
  const selectedComment = useMemo(() => {
    if (!selectedStatement || !comments) return null;
    return comments.find((c) => c.tid === selectedStatement.tid);
  }, [selectedStatement, comments]);

  // Extract vote data for each group for the selected statement
  const groupVoteData = useMemo(() => {
    if (!selectedStatement || !data['group-votes']) return [];
    
    const tidString = selectedStatement.tid.toString();
    const voteData: Array<{
      groupId: number;
      agree: number;
      disagree: number;
      skip: number;
      total: number;
    }> = [];

    Object.entries(data['group-votes']).forEach(([groupIdStr, groupVotes]) => {
      const groupId = parseInt(groupIdStr, 10);
      const votes = groupVotes.votes[tidString];
      if (votes) {
        const total = votes.A + votes.D + votes.S;
        voteData.push({
          groupId,
          agree: votes.A,
          disagree: votes.D,
          skip: votes.S,
          total,
        });
      }
    });

    return voteData;
  }, [selectedStatement, data]);

  // Clear selected statement when context changes
  useEffect(() => {
    if (!isConsensusSelected && selectedStatement?.context === 'consensus') {
      setSelectedStatement(null);
    }
  }, [isConsensusSelected, selectedStatement]);

  useEffect(() => {
    if (selectedGroup === null && selectedStatement && typeof selectedStatement.context === 'object') {
      setSelectedStatement(null);
    }
  }, [selectedGroup, selectedStatement]);

  // Extract statements based on current context (consensus or group repness)
  const statements = useMemo(() => {
    if (isConsensusSelected) {
      // Use group-aware-consensus data
      if (data['group-aware-consensus']) {
        const consensusScores = data['group-aware-consensus'];
        const selectedTids = selectTopConsensusItems(consensusScores);
        
        const resultStatements: Array<{ tid: number; pSuccess: number; type: 'agree' | 'disagree' }> = [];
        
        selectedTids.forEach((tidStr) => {
          const tid = parseInt(tidStr, 10);
          
          // Calculate stats from group-votes
          let totalAgree = 0;
          let totalDisagree = 0;
          
          if (data['group-votes']) {
            Object.values(data['group-votes']).forEach((groupVotes) => {
              const votes = groupVotes.votes[tidStr];
              if (votes) {
                totalAgree += votes.A;
                totalDisagree += votes.D;
              }
            });
          }
          
          const totalVotes = totalAgree + totalDisagree;
          if (totalVotes > 0) {
            const pAgree = totalAgree / totalVotes;
            const pDisagree = totalDisagree / totalVotes;
            
            if (pAgree >= pDisagree) {
              resultStatements.push({
                tid,
                pSuccess: pAgree,
                type: 'agree',
              });
            } else {
              resultStatements.push({
                tid,
                pSuccess: pDisagree,
                type: 'disagree',
              });
            }
          }
        });
        
        // Sort by pSuccess descending, then by TID ascending
        return resultStatements.sort((a, b) => {
          const pSuccessDiff = b.pSuccess - a.pSuccess;
          if (pSuccessDiff !== 0) return pSuccessDiff;
          return a.tid - b.tid;
        });
      }
    } else if (selectedGroup !== null && data.repness) {
      // Extract repness statements for selected group
      const groupRepness = data.repness[selectedGroup.toString()];
      if (!groupRepness) return [];
      
      return groupRepness.map((item) => ({
        tid: item.tid,
        pSuccess: item['p-success'],
        type: item['repful-for'] as 'agree' | 'disagree',
      })).sort((a, b) => {
        const pSuccessDiff = b.pSuccess - a.pSuccess;
        if (pSuccessDiff !== 0) return pSuccessDiff;
        return a.tid - b.tid;
      });
    }
    
    return [];
  }, [isConsensusSelected, selectedGroup, data]);

  // Transform the data into a more usable format
  const baseClusters: BaseCluster[] = useMemo(() => {
    const groupClusters = data['group-clusters'];

    // Create a map of base cluster ID to group ID
    const clusterToGroup = new Map<number, number>();
    groupClusters.forEach((groupCluster) => {
      groupCluster.members.forEach((memberId) => {
        clusterToGroup.set(memberId, groupCluster.id);
      });
    });

    // Transform base clusters
    const baseClustersData = data['base-clusters'];
    return baseClustersData.id.map((id, index) => ({
      id,
      x: baseClustersData.x[index],
      y: baseClustersData.y[index],
      count: baseClustersData.count[index],
      groupId: clusterToGroup.get(id) ?? -1,
      members: baseClustersData.members ? baseClustersData.members[index] : [],
    }));
  }, [data]);

  // Calculate data bounds for scales
  const xExtent = useMemo(() => {
    const xValues = baseClusters.map((d) => d.x);
    return [Math.min(...xValues), Math.max(...xValues)] as [number, number];
  }, [baseClusters]);

  const yExtent = useMemo(() => {
    const yValues = baseClusters.map((d) => d.y);
    return [Math.min(...yValues), Math.max(...yValues)] as [number, number];
  }, [baseClusters]);

  // Scales with some padding
  const xScale = useMemo(() => {
    const [min, max] = xExtent;
    const padding = (max - min) * 0.1;
    return scaleLinear<number>({
      domain: [min - padding, max + padding],
      range: [0, xMax],
    });
  }, [xExtent]);

  const yScale = useMemo(() => {
    const [min, max] = yExtent;
    const padding = (max - min) * 0.1;
    return scaleLinear<number>({
      domain: [min - padding, max + padding],
      range: [0, yMax], // Negative values render upward from origin
    });
  }, [yExtent]);

  // Calculate concave hulls for each group
  const hulls = useMemo(() => {
    const groupClusters = data['group-clusters'];

    return groupClusters.map((groupCluster) => {
      const groupBaseClusters = baseClusters.filter((cluster) => cluster.groupId === groupCluster.id);
      const points = groupBaseClusters.map(
        (cluster) => [xScale(cluster.x), yScale(cluster.y)] as [number, number],
      );
      const participantCount = groupBaseClusters.reduce((sum, cluster) => sum + cluster.count, 0);
      const center = groupCluster.center
        ? ([xScale(groupCluster.center[0]), yScale(groupCluster.center[1])] as [number, number])
        : undefined;

      const hull = concaveHull(points, CONCAVITY, LENGTH_THRESHOLD);
      return { groupId: groupCluster.id, hull, points, participantCount, center };
    });
  }, [data, baseClusters, xScale, yScale]);

  // Calculate origin line positions
  const originX = useMemo(() => xScale(0), [xScale]);
  const originY = useMemo(() => yScale(0), [yScale]);

  // Find user's cluster position
  const userPosition = useMemo(() => {
    if (userPid === null || userPid < 0) return null;
    
    const userCluster = baseClusters.find(cluster => cluster.members.includes(userPid));
    if (!userCluster) return null;

    return {
      x: xScale(userCluster.x),
      y: yScale(userCluster.y)
    };
  }, [userPid, baseClusters, xScale, yScale]);

  return (
    <section className="section-card">
      <h2>Opinion Groups</h2>
      <svg width={width} height={height} style={{ maxWidth: '100%', height: 'auto' }} viewBox={`0 0 ${width} ${height}`}>
        <Group left={margin.left} top={margin.top}>
          {/* Origin lines */}
          {originX >= 0 && originX <= xMax && (
            <line
              x1={originX}
              y1={0}
              x2={originX}
              y2={yMax}
              stroke="var(--color-axis-line)"
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          )}
          {originY >= 0 && originY <= yMax && (
            <line
              x1={0}
              y1={originY}
              x2={xMax}
              y2={originY}
              stroke="var(--color-axis-line)"
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          )}

          {/* Group hull polygons (animated) */}
          {hulls.map(({ groupId, hull, points }, i) => {
            const baseColor = groupColors[groupId] ?? '#e0e0e0';
            const isSelected = selectedGroup === groupId;
            
            // Darker when selected, base gray when not
            const color = isSelected ? '#555555' : baseColor;
            
            const groupKey = `group-${groupId}`;

            if (hull) {
              const pathString = `M${hull.map((point: number[]) => point.join(',')).join('L')}Z`;
              return (
                <motion.path
                  key={`${groupKey}-hull`}
                  d={pathString}
                  fill={color}
                  fillOpacity={isSelected ? 0.35 : 0.2}
                  stroke={color}
                  strokeWidth={isSelected ? 4 : 2}
                  strokeOpacity={isSelected ? 1 : 1}
                  initial={false}
                  animate={{ 
                    d: pathString,
                    fill: color,
                    fillOpacity: isSelected ? 0.35 : 0.2,
                    strokeWidth: isSelected ? 3 : 2,
                  }}
                  transition={{ 
                    duration: 0.8, 
                    ease: "easeInOut" 
                  }}
                />
              );
            }

            if (points.length === 2) {
              return (
                <motion.line
                  key={`${groupKey}-line`}
                  x1={points[0][0]}
                  y1={points[0][1]}
                  x2={points[1][0]}
                  y2={points[1][1]}
                  stroke={color}
                  strokeWidth={isSelected ? 4 : 2}
                  strokeLinecap="round"
                  initial={false}
                  animate={{ 
                    x1: points[0][0],
                    y1: points[0][1],
                    x2: points[1][0],
                    y2: points[1][1],
                    stroke: color,
                    strokeWidth: isSelected ? 3 : 2,
                  }}
                  transition={{ duration: 0.8, ease: "easeInOut" }}
                />
              );
            }

            return null;
          })}

          {/* User position indicator */}
          {userPosition && (
            <Group>
              <defs>
                <pattern
                  id="user-profile-pattern"
                  x="0"
                  y="0"
                  width="1"
                  height="1"
                  patternContentUnits="objectBoundingBox"
                >
                  <image
                    x="0"
                    y="0"
                    width="1"
                    height="1"
                    xlinkHref="/anonProfile.svg"
                    preserveAspectRatio="xMidYMid slice"
                  />
                </pattern>
                <filter id="grayscale-filter">
                  <feColorMatrix type="saturate" values="0" />
                </filter>
              </defs>
              <motion.circle
                cx={userPosition.x}
                cy={userPosition.y}
                r={13}
                fill="none"
                stroke="#03a9f4"
                strokeWidth={4}
                initial={false}
                animate={{ 
                  cx: userPosition.x, 
                  cy: userPosition.y 
                }}
                transition={{ 
                  duration: 0.8, 
                  ease: "easeInOut" 
                }}
              />
              <motion.circle
                cx={userPosition.x}
                cy={userPosition.y}
                r={11}
                fill="url(#user-profile-pattern)"
                filter="url(#grayscale-filter)"
                initial={false}
                animate={{ 
                  cx: userPosition.x, 
                  cy: userPosition.y 
                }}
                transition={{ 
                  duration: 0.8, 
                  ease: "easeInOut" 
                }}
              />
            </Group>
          )}

          {/* Group labels (rendered above shapes) */}
          {hulls.map(({ groupId, participantCount, center }) => {
            if (!center || participantCount <= 0) return null;

            const isSelected = selectedGroup === groupId;
            const labelLetter = groupLetters[groupId] ?? '';
            const iconSize = 16;
            let labelOffsetY = 28;
            const padding = 6;

            // Adjust label position to avoid obscuring user circle
            if (userPosition) {
              // Estimate label center (default position is above the hull center)
              const defaultLabelY = center[1] - 28;
              const dist = Math.hypot(center[0] - userPosition.x, defaultLabelY - userPosition.y);
              
              // If user is too close to the default label position, push the label further up
              if (dist < 45) {
                labelOffsetY = 60;
              }
            }
            const cornerRadius = 6;
            const textStyle = {
              fill: isSelected ? '#ffffff' : 'currentColor',
              fontSize: 12,
              fontWeight: 600,
            } as const;

            // Calculate content positions (relative to center)
            const letterX = -(iconSize / 2) - 6; // Right edge of letter (textAnchor="end")
            const iconX = -iconSize / 2;
            const numberX = iconSize / 2 + 4;
            
            // Estimate label dimensions
            const letterWidth = 8;
            const numberWidth = participantCount.toString().length * 12;
            const contentLeft = letterX - letterWidth; // Left edge of letter
            const contentRight = numberX + numberWidth; // Right edge of number
            const contentWidth = contentRight - contentLeft;
            const labelWidth = contentWidth + padding * 2;
            const labelHeight = iconSize + padding * 2;
            
            // Position rectangle so content is centered within it
            const labelX = contentLeft - padding;
            const labelY = -(labelHeight / 2);
            
            // Calculate offset to center the content group
            const contentCenterX = (contentLeft + contentRight) / 2;
            
            return (
              <Group
                key={`group-label-${groupId}`}
                left={center[0] - contentCenterX}
                top={center[1] - labelOffsetY}
                pointerEvents="none"
                style={{ color: isSelected ? '#ffffff' : 'var(--color-text)' }}
              >
                {/* Background rectangle */}
                <rect
                  x={labelX}
                  y={labelY}
                  width={labelWidth}
                  height={labelHeight}
                  rx={cornerRadius}
                  ry={cornerRadius}
                  fill={isSelected ? '#03a9f4' : 'var(--color-surface)'}
                  stroke={isSelected ? '#03a9f4' : 'var(--color-border)'}
                  strokeWidth={1}
                />
                <text
                  x={letterX}
                  y={iconSize / 2 - 4}
                  textAnchor="end"
                  {...textStyle}
                >
                  {labelLetter}
                </text>
                <g transform={`translate(${iconX}, ${-iconSize / 2})`}>
                  <GroupIcon size={iconSize} fill={isSelected ? '#ffffff' : undefined} />
                </g>
                <text x={numberX} y={iconSize / 2 - 4} textAnchor="start" {...textStyle}>
                  {participantCount}
                </text>
              </Group>
            );
          })}

          {/* Horizontal bar charts for selected statement votes */}
          {selectedStatement && groupVoteData.length > 0 && hulls.map(({ groupId, center }) => {
            if (!center) return null;
            
            const voteInfo = groupVoteData.find((v) => v.groupId === groupId);
            if (!voteInfo || voteInfo.total === 0) return null;

            const barWidth = 60; // Total width of the bar chart
            const barHeight = 8;
            const barOffsetY = 20; // Position below the label
            
            // Calculate proportions
            const agreeRatio = voteInfo.agree / voteInfo.total;
            const disagreeRatio = voteInfo.disagree / voteInfo.total;
            const skipRatio = voteInfo.skip / voteInfo.total;
            
            // Calculate segment widths
            const agreeWidth = agreeRatio * barWidth;
            const disagreeWidth = disagreeRatio * barWidth;
            const skipWidth = skipRatio * barWidth;
            
            // Starting position
            const startX = -barWidth / 2;
            const agreeX = startX;
            const disagreeX = startX + agreeWidth;
            const skipX = startX + agreeWidth + disagreeWidth;
            
            return (
              <Group
                key={`group-votes-${groupId}`}
                left={center[0]}
                top={center[1] - 8 + barOffsetY}
                pointerEvents="none"
              >
                {/* Agree segment (green) */}
                {agreeWidth > 0 && (
                  <rect
                    x={agreeX}
                    y={-barHeight / 2}
                    width={agreeWidth}
                    height={barHeight}
                    fill="#10b981"
                  />
                )}
                
                {/* Disagree segment (red) */}
                {disagreeWidth > 0 && (
                  <rect
                    x={disagreeX}
                    y={-barHeight / 2}
                    width={disagreeWidth}
                    height={barHeight}
                    fill="#ef4444"
                  />
                )}
                
                {/* Skip segment (gray/neutral) */}
                {skipWidth > 0 && (
                  <rect
                    x={skipX}
                    y={-barHeight / 2}
                    width={skipWidth}
                    height={barHeight}
                    fill="#9ca3af"
                    fillOpacity={0.5}
                  />
                )}
              </Group>
            );
          })}
        </Group>
      </svg>

      <div style={{ marginTop: '1.8rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        {/* Consensus button */}
        <button
          onClick={() => {
            const newValue = !isConsensusSelected;
            setisConsensusSelected(newValue);
            if (newValue) {
              setSelectedGroup(null); // Clear group selection when consensus is selected
            }
            setSelectedStatement(null); // Reset selected statement
          }}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '8px',
            border: '1px solid var(--color-border)',
            backgroundColor: isConsensusSelected
              ? '#03a9f4'
              : 'var(--color-surface)',
            color: isConsensusSelected
              ? '#ffffff'
              : 'var(--color-text)',
            cursor: 'pointer',
            fontSize: '0.95rem',
            fontWeight: 500,
            transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease',
          }}
          onMouseEnter={(e) => {
            if (!isConsensusSelected) {
              e.currentTarget.style.backgroundColor = 'var(--color-surface-alt)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isConsensusSelected) {
              e.currentTarget.style.backgroundColor = 'var(--color-surface)';
            }
          }}
        >
          Consensus
        </button>

        {/* Group selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ color: 'var(--color-text)', fontSize: '0.95rem' }}>Group:</span>
          {hulls.map(({ groupId }) => {
            const color = groupColors[groupId] ?? '#999';
            const letter = groupLetters[groupId] ?? '';
            return (
              <button
                key={`group-selector-${groupId}`}
                onClick={() => {
                  // Toggle group selection
                  if (selectedGroup === groupId) {
                    setSelectedGroup(null);
                  } else {
                    setSelectedGroup(groupId);
                    setisConsensusSelected(false); // Clear consensus selection when group is selected
                  }
                  setSelectedStatement(null); // Reset selected statement
                }}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: '8px',
                  border: selectedGroup === groupId 
                    ? '3px solid #000000' 
                    : '2px solid transparent',
                  backgroundColor: selectedGroup === groupId ? '#03a9f4' : color,
                  color: selectedGroup === groupId ? '#ffffff' : '#333333',
                  cursor: 'pointer',
                  fontSize: '0.95rem',
                  fontWeight: selectedGroup === groupId ? 700 : 600,
                  transition: 'opacity 0.2s ease, transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease',
                  boxShadow: selectedGroup === groupId 
                    ? '0 0 0 3px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(0, 0, 0, 0.3)' 
                    : 'none',
                  transform: selectedGroup === groupId ? 'scale(1.05)' : 'scale(1)',
                }}
                onMouseEnter={(e) => {
                  if (selectedGroup !== groupId) {
                    e.currentTarget.style.opacity = '0.85';
                    e.currentTarget.style.transform = 'scale(1.05)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedGroup !== groupId) {
                    e.currentTarget.style.opacity = '1';
                    e.currentTarget.style.transform = 'scale(1)';
                  } else {
                    e.currentTarget.style.transform = 'scale(1.05)';
                  }
                }}
              >
                {letter}
              </button>
            );
          })}
        </div>

        {/* Statement selector */}
        {(isConsensusSelected || selectedGroup !== null) && statements.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginLeft: '0.5rem', flexWrap: 'wrap', maxWidth: '100%' }}>
            <span style={{ color: 'var(--color-text)', fontSize: '0.95rem' }}>Statement:</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {statements.map((statement) => (
                <button
                  key={`statement-${statement.tid}`}
                  onClick={() => {
                    // Determine context based on current selection mode
                    const context: StatementContext = isConsensusSelected 
                      ? 'consensus' 
                      : { groupId: selectedGroup! };
                    
                    // Toggle selection: if already selected with same context, deselect it
                    if (
                      selectedStatement?.tid === statement.tid &&
                      ((context === 'consensus' && selectedStatement.context === 'consensus') ||
                       (typeof context === 'object' && typeof selectedStatement.context === 'object' && 
                        selectedStatement.context.groupId === context.groupId))
                    ) {
                      setSelectedStatement(null);
                    } else {
                      setSelectedStatement({
                        ...statement,
                        context,
                      });
                    }
                  }}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '8px',
                    border: `1px solid ${
                      selectedStatement?.tid === statement.tid &&
                      ((isConsensusSelected && selectedStatement.context === 'consensus') ||
                       (selectedGroup !== null && typeof selectedStatement.context === 'object' &&
                        selectedStatement.context.groupId === selectedGroup))
                        ? 'var(--color-button-bg)'
                        : 'var(--color-border)'
                    }`,
                    backgroundColor:
                      selectedStatement?.tid === statement.tid &&
                      ((isConsensusSelected && selectedStatement.context === 'consensus') ||
                       (selectedGroup !== null && typeof selectedStatement.context === 'object' &&
                        selectedStatement.context.groupId === selectedGroup))
                        ? 'var(--color-surface-alt)'
                        : 'var(--color-surface)',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    transition: 'background-color 0.2s ease, border-color 0.2s ease',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => {
                    const isSelected = selectedStatement?.tid === statement.tid &&
                      ((isConsensusSelected && selectedStatement.context === 'consensus') ||
                       (selectedGroup !== null && typeof selectedStatement.context === 'object' &&
                        selectedStatement.context.groupId === selectedGroup));
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--color-surface-alt)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    const isSelected = selectedStatement?.tid === statement.tid &&
                      ((isConsensusSelected && selectedStatement.context === 'consensus') ||
                       (selectedGroup !== null && typeof selectedStatement.context === 'object' &&
                        selectedStatement.context.groupId === selectedGroup));
                    if (!isSelected) {
                      e.currentTarget.style.backgroundColor = 'var(--color-surface)';
                    }
                  }}
                >
                  {statement.tid}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Comment text display */}
      {(isConsensusSelected || selectedGroup !== null) && selectedStatement && selectedComment && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            backgroundColor: 'var(--color-surface-alt)',
            borderRadius: '8px',
            border: '1px solid var(--color-border)',
          }}
        >
          <p style={{ color: 'var(--color-text)', fontSize: '0.95rem', margin: 0 }}>
            <strong>#{selectedComment.tid}</strong> {selectedComment.txt}
          </p>
        </div>
      )}

      {/* Statement details */}
      {(isConsensusSelected || selectedGroup !== null) && selectedStatement && (
        <div
          style={{
            marginTop: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1rem',
            backgroundColor: 'var(--color-surface-alt)',
            borderRadius: '8px',
            border: '1px solid var(--color-border)',
          }}
        >
          {selectedStatement.type === 'agree' ? (
            <CheckCircleIcon fill="#10b981" />
          ) : (
            <BanIcon fill="#ef4444" />
          )}
          <span style={{ color: 'var(--color-text)', fontSize: '0.95rem' }}>
            {Math.floor(selectedStatement.pSuccess * 100)}% of{' '}
            {selectedStatement.context === 'consensus' 
              ? 'everyone' 
              : `those in group ${groupLetters[selectedStatement.context.groupId] ?? selectedStatement.context.groupId}`}{' '}
            who voted on statement {selectedStatement.tid}{' '}
            {selectedStatement.type === 'agree' ? 'agreed' : 'disagreed'}.
          </span>
        </div>
      )}
    </section>
  );
}
