class OfflibraryAsset extends EventTarget {
  cached = false;
  constructor(asset, config) {
    super();
    this.asset = asset;
    this.config = config;
  }

  uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (
        c ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
      ).toString(16)
    );
  }

  getSizeOnline(url) {
    return fetch(url, { method: 'HEAD' })
      .then((res) => {
        if (!res.ok) throw new Error('Something went wrong');

        return Number(res.headers.get('content-length'));
      })
      .catch((err) => {
        console.error(err);
        throw new Error(err);
      });
  }

  getSizeOffline(url) {
    return caches
      .match(url, { cacheName: this.config.cache.name })
      .then((res) => {
        if (res !== undefined) {
          return Number(res.headers.get('content-length'));
        } else {
          throw new Error('Something went wrong');
        }
      })
      .catch((err) => {
        console.error(err);
        throw new Error(err);
      });
  }

  init() {
    return caches
      .open(this.config.cache.name)
      .then((cache) => {
        return cache
          .keys()
          .then((keys) => {
            if (keys.find((req) => req.url === this.asset.url)) {
              this.cached = true;

              if (!this.asset.size && this.config.autoGetSize) {
                return this.getSizeOffline(this.asset.url)
                  .then((size) => {
                    this.asset.size = size;
                    this.dispatchEvent(
                      new CustomEvent('initialized', { detail: this.asset })
                    );
                    return this.asset;
                  })
                  .catch((err) => {
                    throw new Error(err);
                  });
              }
            } else {
              this.cached = false;

              if (!this.asset.size && this.config.autoGetSize) {
                return this.getSizeOnline(this.asset.url)
                  .then((size) => {
                    this.asset.size = size;
                    this.dispatchEvent(
                      new CustomEvent('initialized', { detail: this.asset })
                    );
                    return this.asset;
                  })
                  .catch((err) => {
                    throw new Error(err);
                  });
              }
            }

            this.dispatchEvent(
              new CustomEvent('initialized', { detail: this.asset })
            );
            return this.asset;
          })
          .catch((err) => {
            throw new Error(err);
          });
      })
      .catch((err) => {
        console.error(err);
        throw new Error(err);
      });
  }

  extract() {
    return caches
      .match(this.asset.url, { cacheName: this.config.cache.name })
      .then((res) => {
        if (res !== undefined) {
          this.dispatchEvent(
            new CustomEvent('extracted', { detail: this.asset })
          );
          return res;
        } else {
          throw new Error('Something went wrong');
        }
      })
      .catch((err) => {
        console.error(err);
        throw new Error(err);
      });
  }

  cache() {
    if (this.asset.size > this.config.cache.bgFetchThreshold) {
      return navigator.serviceWorker.ready
        .then((registration) => {

            registration.active.postMessage({'hello': 'world registration'});
            //navigator.serviceWorker.controller.postMessage({'hello': 'world controller'});

            navigator.serviceWorker.addEventListener('message', event => {
                
                this.cached = true;

                this.dispatchEvent(
                    new CustomEvent('bgfetched', { detail: this.asset })
                  );

                console.log(`The service worker sent me a message: ${event.data}`);
              });

          return registration.backgroundFetch
            .fetch(
              `${this.config.cache.name}/${this.uuidv4()}`,
              [this.asset.url],
              {
                icons: [],
                title: `Downloading ${this.asset.title}`,
                downloadTotal: this.asset.size,
              }
            )
            .then((bgFetchRegistration) => {





              bgFetchRegistration.addEventListener('progress', (event) => {
                const fetchProgress = event.currentTarget;
                console.log(`Progress: 
                     (${Math.round(
                       (fetchProgress.downloaded * 100) /
                         fetchProgress.downloadTotal
                     )}%)`);
              });

              return this.asset;
            })
            .catch((err) => {
              throw new Error(err);
            });
        })
        .catch((err) => {
          console.error(err);
          throw new Error(err);
        });
    } else {
      return fetch(this.asset.url)
        .then((res) => {
          if (!res.ok) throw new Error('Something went wrong');

          return caches
            .open(this.config.cache.name)
            .then((cache) => {
              return cache
                .put(this.asset.url, res)
                .then(() => {
                  this.cached = true;

                  this.dispatchEvent(
                    new CustomEvent('cached', { detail: this.asset })
                  );
                  return this.asset;
                })
                .catch((err) => {
                  throw new Error(err);
                });
            })
            .catch((err) => {
              throw new Error(err);
            });
        })
        .catch((err) => {
          console.error(err);
          throw new Error(err);
        });
    }
  }

  delete() {
    return caches.open(this.config.cache.name).then((cache) => {
      return cache
        .delete(this.asset.url)
        .then((response) => {
          this.cached = false;
          this.dispatchEvent(
            new CustomEvent('deleted', { detail: this.asset })
          );
          return this.asset;
        })
        .catch((err) => {
          console.error(err);
          throw new Error(err);
        });
    });
  }
}

export { OfflibraryAsset };
