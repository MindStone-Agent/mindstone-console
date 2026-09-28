// Refuses a compose project the harness couldn't safely tear down. The
// compose file comes from the ref under test, and `compose down -v` removes
// whatever volumes and networks it names; a build overwrites whatever tag it
// names. So, before `up`, every name must belong to this run's project.
//
//   docker compose config --format json | node compose-guard.mjs <project> <allowed-bind-root>
//
// Refused:
// - a container_name not prefixed with the project;
// - a built service (`build:`) whose image tag isn't prefixed with the project
//   (a pulled image, like mongo, is only read, so any name is fine);
// - a volume or network whose resolved name isn't prefixed with the project,
//   or that is `external`;
// - a bind mount from outside the Console checkout.
// Exit 0 with a one-line summary; exit 1 listing each refusal.
import path from 'node:path';

const [project, bindRoot] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const refusals = [];
const owned = (name) => typeof name === 'string' && (name === project || name.startsWith(`${project}-`) || name.startsWith(`${project}_`));
const root = path.resolve(bindRoot);

for (const [name, service] of Object.entries(config.services ?? {})) {
  if (service.container_name && !owned(service.container_name)) {
    refusals.push(`service ${name}: container_name "${service.container_name}" isn't this project's`);
  }
  if (service.build && service.image && !owned(service.image.split(':')[0])) {
    refusals.push(`service ${name}: builds into image "${service.image}", which isn't this project's`);
  }
  for (const mount of service.volumes ?? []) {
    if (mount.type === 'bind') {
      const source = path.resolve(mount.source ?? '');
      if (source !== root && !source.startsWith(`${root}${path.sep}`)) {
        refusals.push(`service ${name}: bind mount from outside the checkout (${mount.source})`);
      }
    }
  }
}
for (const [key, volume] of Object.entries(config.volumes ?? {})) {
  if (volume?.external) refusals.push(`volume ${key}: external`);
  else if (!owned(volume?.name ?? `${project}_${key}`)) refusals.push(`volume ${key}: name "${volume.name}" isn't this project's`);
}
for (const [key, network] of Object.entries(config.networks ?? {})) {
  if (network?.external) refusals.push(`network ${key}: external`);
  else if (!owned(network?.name ?? `${project}_${key}`)) refusals.push(`network ${key}: name "${network.name}" isn't this project's`);
}

if (refusals.length) {
  console.log(`compose-guard: REFUSED ${refusals.length} item(s):`);
  for (const r of refusals) console.log(`  ${r}`);
  process.exit(1);
}
const services = Object.keys(config.services ?? {});
console.log(
  `compose-guard: ok (${services.length} services, ${Object.keys(config.volumes ?? {}).length} volumes, ` +
    `${Object.keys(config.networks ?? {}).length} networks; every name is ${project}'s, binds inside the checkout)`,
);
