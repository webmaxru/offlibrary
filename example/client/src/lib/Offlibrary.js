import { OfflibraryAsset } from './OfflibraryAsset.js';

class Offlibrary extends EventTarget {
  #offlibraryConfig;
  #registered = {};

  constructor(offlibraryConfig) {
    super();
    if (offlibraryConfig) {
      this.offlibraryConfig = offlibraryConfig;
    }
  }
  
  setConfig(offlibraryConfig) {
    this.offlibraryConfig = offlibraryConfig;
    return this;
  }

  getConfig() {
    return this.offlibraryConfig;
  }

  asset(asset) {
    return new OfflibraryAsset(asset, this.offlibraryConfig);
  }
}

export { Offlibrary };
