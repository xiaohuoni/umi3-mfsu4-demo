import { parseModule } from '@umijs/bundler-utils';
import { logger } from '@umijs/utils';
import type { NextFunction, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { extname, join } from 'path';
import webpack, { Configuration } from 'webpack';
import Config from '@umijs/bundler-webpack/compiled/webpack-5-chain';

import { lookup } from '@umijs/mfsu/compiled/mrmime';
// @ts-ignore
import WebpackVirtualModules from '@umijs/mfsu/compiled/webpack-virtual-modules';
import autoExport from '@umijs/mfsu/dist/babelPlugins/autoExport';
import awaitImport from '@umijs/mfsu/dist/babelPlugins/awaitImport/awaitImport';
import { getRealPath } from '@umijs/mfsu/dist/babelPlugins/awaitImport/getRealPath';
import {
  DEFAULT_MF_NAME,
  DEFAULT_TMP_DIR_NAME,
  MF_DEP_PREFIX,
  MF_STATIC_PREFIX,
  MF_VA_PREFIX,
  REMOTE_FILE,
  REMOTE_FILE_FULL,
} from '@umijs/mfsu/dist/constants';
import { Dep } from '@umijs/mfsu/dist/dep/dep';
import { DepBuilder } from '@umijs/mfsu/dist/depBuilder/depBuilder';
import { DepInfo } from '@umijs/mfsu/dist/depInfo';
import { Mode } from '@umijs/mfsu/dist/types';
import { makeArray } from '@umijs/mfsu/dist/utils/makeArray';
import { BuildDepPlugin } from '@umijs/mfsu/dist/webpackPlugins/buildDepPlugin';
import { WriteCachePlugin } from '@umijs/mfsu/dist/webpackPlugins/writeCachePlugin';

interface IOpts {
  cwd?: string;
  excludeNodeNatives?: boolean;
  exportAllMembers?: Record<string, string[]>;
  getCacheDependency?: Function;
  mfName?: string;
  mode?: Mode;
  tmpBase?: string;
  unMatchLibs?: string[];
  runtimePublicPath?: boolean | string;
  implementor: typeof webpack;
  buildDepWithESBuild?: boolean;
  depBuildConfig: any;
}

export class MFSU {
  public opts: IOpts;
  public alias: Record<string, string> = {};
  public externals: (Record<string, string> | Function)[] = [];
  public depInfo: DepInfo;
  public depBuilder: DepBuilder;
  public depConfig: Configuration | null = null;
  constructor(opts: IOpts) {
    this.opts = opts;
    this.opts.mfName = this.opts.mfName || DEFAULT_MF_NAME;
    this.opts.tmpBase =
      this.opts.tmpBase || join(process.cwd(), DEFAULT_TMP_DIR_NAME);
    this.opts.mode = this.opts.mode || Mode.development;
    this.opts.getCacheDependency = this.opts.getCacheDependency || (() => ({}));
    this.opts.cwd = this.opts.cwd || process.cwd();
    this.depInfo = new DepInfo({ mfsu: this });
    this.depBuilder = new DepBuilder({ mfsu: this });
    this.depInfo.loadCache();
  }

  // swc don't support top-level await
  // ref: https://github.com/vercel/next.js/issues/31054
  asyncImport(content: string) {
    return `await import('${content}');`;
    // return `(async () => await import('${content}'))();`;
  }

  async setWebpackConfig(opts: {
    config: Configuration;
    depConfig: Configuration;
  }) {
    const { mfName } = this.opts;

    /**
     * config
     */
    // set alias and externals with reference for babel plugin
    Object.assign(this.alias, opts.config.resolve?.alias || {});
    this.externals.push(...makeArray(opts.config.externals || []));
    // entry
    const entry: Record<string, string> = {};
    const virtualModules: Record<string, string> = {};
    for (const key of Object.keys(opts.config.entry!)) {
      const virtualPath = `./mfsu-virtual-entry/${key}.js`;
      const virtualContent: string[] = [];
      let index = 1;
      let hasDefaultExport = false;
      // @ts-ignore
      for (const entry of opts.config.entry![key]) {
        const content = readFileSync(entry, 'utf-8');
        const [_imports, exports] = await parseModule({ content, path: entry });
        if (exports.length) {
          virtualContent.push(`const k${index} = ${this.asyncImport(entry)}`);
          for (const exportName of exports) {
            if (exportName === 'default') {
              hasDefaultExport = true;
              virtualContent.push(`export default k${index}.${exportName}`);
            } else {
              virtualContent.push(
                `export const ${exportName} = k${index}.${exportName}`,
              );
            }
          }
        } else {
          virtualContent.push(this.asyncImport(entry));
        }
        index += 1;
      }
      if (!hasDefaultExport) {
        virtualContent.push(`export default 1;`);
      }
      virtualModules[virtualPath] = virtualContent.join('\n');
      entry[key] = virtualPath;
    }
    opts.config.entry = entry;
    // plugins
    opts.config.plugins = opts.config.plugins || [];

    // support publicPath auto
    let publicPath = opts.config.output!.publicPath;
    if (publicPath === 'auto') {
      publicPath = '/';
    }

    opts.config.plugins!.push(
      ...[
        new WebpackVirtualModules(virtualModules),
        new this.opts.implementor.container.ModuleFederationPlugin({
          name: '__',
          remotes: {
            [mfName!]: this.opts.runtimePublicPath
              ? // ref:
              // https://webpack.js.org/concepts/module-federation/#promise-based-dynamic-remotes
              `
promise new Promise(resolve => {
  const remoteUrlWithVersion = window.publicPath + '${REMOTE_FILE_FULL}';
  const script = document.createElement('script');
  script.src = remoteUrlWithVersion;
  script.onload = () => {
    // the injected script has loaded and is available on window
    // we can now resolve this Promise
    const proxy = {
      get: (request) => window['${mfName}'].get(request),
      init: (arg) => {
        try {
          return window['${mfName}'].init(arg);
        } catch(e) {
          console.log('remote container already initialized');
        }
      }
    }
    resolve(proxy);
  }
  // inject this script with the src set to the versioned remoteEntry.js
  document.head.appendChild(script);
})
                `.trimLeft()
              : `${mfName}@${publicPath}${REMOTE_FILE_FULL}`,
          },
        }),
        new BuildDepPlugin({
          onCompileDone: () => {
            this.buildDeps().catch((e) => {
              logger.error(e);
            });
          },
        }),
        new WriteCachePlugin({
          onWriteCache: () => {
            this.depInfo.writeCache();
          },
        }),
      ],
    );

    /**
     * depConfig
     */
    this.depConfig = opts.depConfig;
  }

  async chainWebpackConfig(opts: {
    config: Config;
    depConfig: Configuration;
  }) {
    const { mfName } = this.opts;
    // 取值给 mfsu
    const config = opts.config?.toConfig();
    /**
     * config
     */
    // set alias and externals with reference for babel plugin
    Object.assign(this.alias, config.resolve?.alias || {});
    this.externals.push(...makeArray(config.externals || []));
    const virtualModules: Record<string, string> = {};
    for (const key of Object.keys(config.entry!)) {
      const virtualPath = `./mfsu-virtual-entry/${key}.js`;
      const virtualContent: string[] = [];
      let index = 1;
      let hasDefaultExport = false;
      // @ts-ignore
      for (const entry of config.entry![key]) {
        const content = readFileSync(entry, 'utf-8');
        const [_imports, exports] = await parseModule({ content, path: entry });
        if (exports.length) {
          virtualContent.push(`const k${index} = ${this.asyncImport(entry)}`);
          for (const exportName of exports) {
            if (exportName === 'default') {
              hasDefaultExport = true;
              virtualContent.push(`export default k${index}.${exportName}`);
            } else {
              virtualContent.push(
                `export const ${exportName} = k${index}.${exportName}`,
              );
            }
          }
        } else {
          virtualContent.push(this.asyncImport(entry));
        }
        index += 1;
      }
      if (!hasDefaultExport) {
        virtualContent.push(`export default 1;`);
      }
      virtualModules[virtualPath] = virtualContent.join('\n');
      // entry[key] = virtualPath;
      opts.config.entry(key).clear().add(virtualPath)
    }
    // opts.config.entry = entry;
    // plugins
    // opts.config.plugins = opts.config.plugins || [];

    // support publicPath auto
    let publicPath = config.output!.publicPath;
    if (publicPath === 'auto') {
      publicPath = '/';
    }
    opts.config.plugin('WebpackVirtual')
      .use(WebpackVirtualModules, [virtualModules])
    opts.config.plugin('ModuleFederation')
      .use(this.opts.implementor.container.ModuleFederationPlugin, [{
        name: '__',
        remotes: {
          [mfName!]: this.opts.runtimePublicPath
            ? // ref:
            // https://webpack.js.org/concepts/module-federation/#promise-based-dynamic-remotes
            `
promise new Promise(resolve => {
  const remoteUrlWithVersion = window.publicPath + '${REMOTE_FILE_FULL}';
  const script = document.createElement('script');
  script.src = remoteUrlWithVersion;
  script.onload = () => {
    // the injected script has loaded and is available on window
    // we can now resolve this Promise
    const proxy = {
      get: (request) => window['${mfName}'].get(request),
      init: (arg) => {
        try {
          return window['${mfName}'].init(arg);
        } catch(e) {
          console.log('remote container already initialized');
        }
      }
    }
    resolve(proxy);
  }
  // inject this script with the src set to the versioned remoteEntry.js
  document.head.appendChild(script);
})
                `.trimLeft()
            : `${mfName}@${publicPath}${REMOTE_FILE_FULL}`,
        },
      }])

    opts.config.plugin('BuildDep')
      .use(BuildDepPlugin, [{
        onCompileDone: () => {
          this.buildDeps().catch((e) => {
            logger.error(e);
          });
        },
      }])
    opts.config.plugin('WriteCache')
      .use(WriteCachePlugin, [{
        onWriteCache: () => {
          this.depInfo.writeCache();
        },
      }])
    /**
     * depConfig
     */
    this.depConfig = opts.depConfig;
  }

  async buildDeps() {
    if (!this.depInfo.shouldBuild()) return;
    this.depInfo.snapshot();
    const deps = Dep.buildDeps({
      deps: this.depInfo.moduleGraph.depSnapshotModules,
      cwd: this.opts.cwd!,
      mfsu: this,
    });
    await this.depBuilder.build({
      deps,
    });
  }

  getMiddlewares() {
    return [
      (req: Request, res: Response, next: NextFunction) => {
        const publicPath = '/';
        const isMF =
          req.path.startsWith(`${publicPath}${MF_VA_PREFIX}`) ||
          req.path.startsWith(`${publicPath}${MF_DEP_PREFIX}`) ||
          req.path.startsWith(`${publicPath}${MF_STATIC_PREFIX}`);
        if (isMF) {
          this.depBuilder.onBuildComplete(() => {
            if (!req.path.includes(REMOTE_FILE)) {
              res.setHeader('cache-control', 'max-age=31536000,immutable');
            }
            res.setHeader(
              'content-type',
              lookup(extname(req.path)) || 'text/plain',
            );
            const relativePath = req.path.replace(
              new RegExp(`^${publicPath}`),
              '/',
            );
            const content = readFileSync(
              join(this.opts.tmpBase!, relativePath),
            );
            res.send(content);
          });
        } else {
          next();
        }
      },
    ];
  }

  getBabelPlugins() {
    return [
      autoExport,
      [
        awaitImport,
        {
          onTransformDeps: () => { },
          onCollect: ({
            file,
            data,
          }: {
            file: string;
            data: {
              unMatched: Set<{ sourceValue: string }>;
              matched: Set<{ sourceValue: string }>;
            };
          }) => {
            this.depInfo.moduleGraph.onFileChange({
              file,
              // @ts-ignore
              deps: [
                ...Array.from(data.matched).map((item: any) => ({
                  file: item.sourceValue,
                  isDependency: true,
                  version: Dep.getDepVersion({
                    dep: item.sourceValue,
                    cwd: this.opts.cwd!,
                  }),
                })),
                ...Array.from(data.unMatched).map((item: any) => ({
                  file: getRealPath({
                    file,
                    dep: item.sourceValue,
                  }),
                  isDependency: false,
                })),
              ],
            });
          },
          exportAllMembers: this.opts.exportAllMembers,
          unMatchLibs: this.opts.unMatchLibs,
          remoteName: this.opts.mfName,
          alias: this.alias,
          externals: this.externals,
        },
      ],
    ];
  }
}
