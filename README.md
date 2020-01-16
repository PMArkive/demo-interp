## demo-interp
Interpolate demo files by filling out gaps between Packets.  
Normally a demo has a Packet every 4 ticks, this fills out the ticks inbetween by interpolating between the Packets.  
Makes a visible difference on low `cl_interp` values at least.
  
## usage
`yarn install`  
`yarn build`  
`cd test`  
`node test-interp.js`