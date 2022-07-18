import './App.css';
import EpisodeList from './EpisodeList.js';

const App = () => {
  return (
    <div className="container">
      <header className="header">
        <h2>
          <a href="/">Offlibrary Demo</a>
        </h2>
      </header>

      <main className="main">
        <EpisodeList />
      </main>

      <footer className="footer">
        Created by&nbsp;
        <a href="https://twitter.com/webmaxru">Maxim Salnikov</a>
        &nbsp;|&nbsp;
        <a href="https://github.com/webmaxru/offlibrary">Fork on GutHub</a>
        &nbsp;|&nbsp;
        <a
          href="https://aka.ms/learn-pwa"
          target="_blank"
          rel="noopener noreferrer"
        >
          Powered by&nbsp;
          <img src="./logo512.png" alt="PWA" className="logo" />
        </a>
      </footer>
    </div>
  );
}

export default App;
