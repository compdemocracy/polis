import { useState, useEffect } from 'react';
import PCAVisualization from './PCAVisualization';
import { fetchPCAData, type PCAData } from '../api/pca';
import { fetchComments, type Comment } from '../api/comments';

interface VisualizationContainerProps {
  conversation_id: string;
}

export default function VisualizationContainer({ conversation_id }: VisualizationContainerProps) {
  const [pcaData, setPcaData] = useState<PCAData | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversation_id) {
      setLoading(false);
      setError('No conversation ID provided');
      return;
    }

    async function loadData() {
      try {
        setLoading(true);
        setError(null);
        // Fetch both PCA data and comments in parallel
        const [pcaDataResult, commentsResult] = await Promise.all([
          fetchPCAData(conversation_id),
          fetchComments(conversation_id),
        ]);
        setPcaData(pcaDataResult);
        setComments(commentsResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch data');
        console.error('Error fetching data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [conversation_id]);

  if (loading) {
    return (
      <section className="section-card loading-state" style={{ textAlign: 'center', padding: '2rem' }}>
        <p>Loading visualization data...</p>
      </section>
    );
  }

  if (error) {
    return (
       <section className="section-card" style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>
          <p>Visualization unavailable</p>
       </section>
    );
  }

  if (!pcaData) {
    return null;
  }

  return (
    <div className="visualization-container">
      <PCAVisualization data={pcaData} comments={comments} conversationId={conversation_id} />
    </div>
  );
}

