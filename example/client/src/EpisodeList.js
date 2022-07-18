import React, { useEffect, useState } from 'react';
import { Offlibrary } from './lib/Offlibrary.js';

const offlibrary = new Offlibrary({
  autoGetSize: true,
  cache: {
    name: 'offlibrary',
    bgFetchThreshold: 100 * 1024 * 1024,
  },
  serviceWorker: {
    name: 'sw.js',
  },
});

offlibrary.addEventListener('success', (event) => {
  console.log(`client success`);
  console.log(event.detail.data);
});

const API_HOST = 'http://localhost:3001';
const ASSETS_HOST = 'http://localhost:3001';

const bytesToSize = (bytes, decimals) => {
  if (bytes == 0) return '0 Bytes';
  var k = 1024,
    dm = decimals <= 0 ? 0 : decimals || 2,
    sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
    i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js');
  });
}

function useForceUpdate() {
  const [value, setValue] = useState(0); // integer state
  return () => setValue((value) => value + 1); // update state to force render
  // An function that increment 👆🏻 the previous state like here
  // is better than directly setting `value + 1`
}

const EpisodeList = () => {
  const [episodeList, setEpisodeList] = useState('');

  const forceUpdate = useForceUpdate();

  const fetchData = async () => {
    try {
      const response = await fetch(`${API_HOST}/api/assets/`);
      const json = await response.json();

      const episodes = json.map((episode) => {
        const offlineAsset = offlibrary.asset({
          title: episode.title,
          url: `${ASSETS_HOST}/assets/${episode.url}`,
          size: null,
        });

        offlineAsset
          .init()
          .then((asset) => {
            setEpisodeList((episodeList) => [...episodeList]);
          })
          .catch((err) => {
            alert(err);
          });

          offlineAsset.addEventListener('bgfetched', (event) => {
            console.log('bgfetched');
            setEpisodeList((episodeList) => [...episodeList]);
          });

        /*

        offlineAsset.addEventListener('initialized', (event) => {
          setEpisodeList((episodeList) => [...episodeList]);
        });

                offlineAsset.addEventListener('deleted', (event) => {
          setEpisodeList((episodeList) => [...episodeList]);
        });
        
        offlineAsset.addEventListener('cached', (event) => {
          setEpisodeList((episodeList) => [...episodeList]);
        }); */

        return { ...episode, offlineAsset: offlineAsset };
      });

      setEpisodeList(episodes);
    } catch (error) {
      console.error('error', error);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const cacheEpisode = (episode) => {
    episode.offlineAsset
      .cache()
      .then((asset) => {
        setEpisodeList((episodeList) => [...episodeList]);
      })
      .catch((err) => {
        alert(err);
      });
  };

  const deleteEpisode = (episode) => {
    episode.offlineAsset
      .delete()
      .then((asset) => {
        setEpisodeList((episodeList) => [...episodeList]);
      })
      .catch((err) => {
        alert(err);
      });
  };

  return (
    <>
      <button onClick={fetchData}>Load assets</button>
      <button onClick={forceUpdate}>Click to re-render</button>
      <ul className="grid">
        {episodeList ? (
          episodeList.map((episode) => {
            return (
              <li key={episode.id} className="card">
                <h3>{episode.title} &rarr;</h3>
                <p>
                  {episode.offlineAsset.cached ? '✅' : '❌'} Available offline{' '}
                </p>
                <p>
                  <button onClick={() => cacheEpisode(episode)}>Cache</button>
                  <button onClick={() => deleteEpisode(episode)}>Delete</button>
                  <button onClick={() => console.log(episode.offlineAsset)}>
                    Out
                  </button>
                </p>
                <p>
                  {episode.offlineAsset.asset.size
                    ? bytesToSize(episode.offlineAsset.asset.size)
                    : ''}
                </p>
              </li>
            );
          })
        ) : (
          <li>Loading...</li>
        )}
      </ul>
    </>
  );
};

export default EpisodeList;
