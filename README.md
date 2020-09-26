## demo-interp

An experiemental project for interpolating TF2 SourceTV demo files.  
Normally a SourceTV demo has a Packet every 4 ticks, this fills out the ticks inbetween by interpolating between the Packets.  
This may be pointless but there is a visible difference when using `cl_interp` values lower than ~60ms (4 / 66 ticks/s).

## usage

`yarn install`  
`yarn build`  
`cd test`  
`node test-interp.js`
